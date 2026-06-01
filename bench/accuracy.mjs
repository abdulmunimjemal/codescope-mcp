#!/usr/bin/env node
// Accuracy benchmark: "did it return the right answer?"
//
// Ground truth comes from the TypeScript compiler (LanguageService.findReferences
// — the same engine that powers go-to-definition in your editor). For each
// definition we compute the TRUE set of files that contain a call to it, then
// score codescope's and codegraph's `callers` answers against that truth:
//   precision = correct files returned / files returned
//   recall    = correct files returned / true files
//   F1        = harmonic mean
//
// Run on a single TypeScript package so module resolution is exact and fair to
// all three (oracle + both tools index the same file set).
//
// Usage: node bench/accuracy.mjs <package-dir>

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { GraphStore, Indexer } from "../dist/index.js";

const CG = ["-y", "@colbymchenry/codegraph@latest"];

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function buildOracle(root) {
  const files = tsFiles(root);
  const options = {
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    baseUrl: root,
  };
  const versions = new Map(files.map((f) => [f, "1"]));
  const host = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => versions.get(f) ?? "1",
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { service, program: service.getProgram(), files };
}

/** The innermost node covering a position. */
function nodeAt(sf, pos) {
  function find(node) {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return undefined;
    return ts.forEachChild(node, find) ?? node;
  }
  return find(sf);
}

/** Is the reference at this position the callee of a call expression? */
function isCallSite(program, fileName, start) {
  const sf = program.getSourceFile(fileName);
  if (!sf) return false;
  const node = nodeAt(sf, start);
  if (!node || !node.parent) return false;
  const p = node.parent;
  if (ts.isCallExpression(p) && p.expression === node) return true;
  if (
    ts.isPropertyAccessExpression(p) &&
    p.name === node &&
    p.parent &&
    ts.isCallExpression(p.parent) &&
    p.parent.expression === p
  )
    return true;
  return false;
}

/** Collect named definitions (functions, methods, classes, arrow consts). */
function collectDefs(program, root) {
  const defs = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root)) continue;
    const visit = (node) => {
      let nameNode;
      if (ts.isFunctionDeclaration(node) && node.name) nameNode = node.name;
      else if (ts.isClassDeclaration(node) && node.name) nameNode = node.name;
      else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) nameNode = node.name;
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        nameNode = node.name;
      if (nameNode) defs.push({ name: nameNode.text, file: sf.fileName, pos: nameNode.getStart(sf) });
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return defs;
}

function f1(p, r) {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function score(returnedFiles, trueFiles) {
  if (trueFiles.size === 0) return null; // nothing to find — skip
  let correct = 0;
  for (const f of returnedFiles) if (trueFiles.has(f)) correct++;
  const precision = returnedFiles.size === 0 ? (trueFiles.size === 0 ? 1 : 0) : correct / returnedFiles.size;
  const recall = correct / trueFiles.size;
  return { precision, recall, f1: f1(precision, recall) };
}

function codegraphCallers(name, root) {
  try {
    const out = execFileSync("npx", [...CG, "callers", name, "-p", root, "-l", "200", "-j"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const json = JSON.parse(out.replace(/\x1b\[[0-9;]*m/g, ""));
    const arr = Array.isArray(json) ? json : (json.callers ?? json.results ?? []);
    const files = new Set();
    for (const c of arr) {
      const f = c.filePath ?? c.file ?? c.path ?? c.location?.file;
      if (f) files.add(relative(root, resolve(root, f)));
    }
    return files;
  } catch {
    return new Set();
  }
}

async function main() {
  const root = resolve(process.argv[2] ?? ".");
  const sampleSize = Number(process.argv[3] ?? 120);
  console.log(`\n=== accuracy vs TypeScript oracle — ${relative(process.cwd(), root) || root} ===`);

  // Oracle
  const { service, program, files } = buildOracle(root);
  // Only count references in the package's own source files — codescope and
  // codegraph index the package (not node_modules / symlinked workspace deps),
  // so scoring against refs outside this set would penalise them unfairly.
  const ownFiles = new Set(files);
  const defs = collectDefs(program, root);

  // codescope index (in-process)
  const store = new GraphStore(":memory:");
  await new Indexer(store, root).indexAll();

  // Warm codegraph + index it once on this package
  execFileSync("npx", [...CG, "--version"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("npx", [...CG, "uninit", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("npx", [...CG, "init", "-i", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });

  const step = Math.max(1, Math.floor(defs.length / sampleSize));
  const sample = defs.filter((_, i) => i % step === 0).slice(0, sampleSize);

  const agg = {
    codescope: { p: 0, r: 0, f: 0, n: 0 },
    codegraph: { p: 0, r: 0, f: 0, n: 0 },
  };

  for (const def of sample) {
    // Oracle truth: files containing a call site of this exact definition.
    const refs = service.findReferences(def.file, def.pos) ?? [];
    const trueFiles = new Set();
    for (const rs of refs) {
      for (const e of rs.references) {
        if (!ownFiles.has(e.fileName)) continue; // skip node_modules / out-of-package refs
        if (e.fileName === def.file && e.textSpan.start === def.pos) continue; // the def itself
        if (isCallSite(program, e.fileName, e.textSpan.start)) {
          trueFiles.add(relative(root, e.fileName));
        }
      }
    }
    if (trueFiles.size === 0) continue;

    const csFiles = new Set(store.findCallers(def.name, { limit: 200 }).map((r) => r.file));
    const cgFiles = codegraphCallers(def.name, root);

    const cs = score(csFiles, trueFiles);
    const cg = score(cgFiles, trueFiles);
    if (cs) {
      agg.codescope.p += cs.precision;
      agg.codescope.r += cs.recall;
      agg.codescope.f += cs.f1;
      agg.codescope.n++;
    }
    if (cg) {
      agg.codegraph.p += cg.precision;
      agg.codegraph.r += cg.recall;
      agg.codegraph.f += cg.f1;
      agg.codegraph.n++;
    }
  }

  execFileSync("npx", [...CG, "uninit", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  store.close();

  const report = (label, a) =>
    console.log(
      `  ${label.padEnd(10)} precision=${(a.p / a.n).toFixed(3)}  recall=${(a.r / a.n).toFixed(3)}  F1=${(a.f / a.n).toFixed(3)}  (n=${a.n})`,
    );
  console.log(`\n  ground-truth call-site sets from the TypeScript compiler:\n`);
  report("codescope", agg.codescope);
  report("codegraph", agg.codegraph);
  const csF1 = agg.codescope.f / agg.codescope.n;
  const cgF1 = agg.codegraph.f / agg.codegraph.n;
  console.log(`\n  → ${csF1 >= cgF1 ? "codescope ✓ (>= codegraph)" : "codegraph ahead"}  (F1 ${csF1.toFixed(3)} vs ${cgF1.toFixed(3)})`);
}

main();
