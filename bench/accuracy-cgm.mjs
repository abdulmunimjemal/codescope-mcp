#!/usr/bin/env node
// Accuracy: codescope vs @sdsrs/code-graph (code-graph-mcp) against a
// precomputed ground-truth oracle (same scoring as accuracy-generic.mjs).
//
// Usage: node bench/accuracy-cgm.mjs <repo-dir> <oracle.json>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { GraphStore, Indexer } from "../dist/index.js";

const CGM = ["-y", "@sdsrs/code-graph"];
const root = resolve(process.argv[2]);
const oracle = JSON.parse(readFileSync(process.argv[3], "utf8"));

const f1 = (p, r) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
function score(returned, truth) {
  let c = 0;
  for (const f of returned) if (truth.has(f)) c++;
  const precision = returned.size === 0 ? 0 : c / returned.size;
  const recall = truth.size === 0 ? 0 : c / truth.size;
  return { precision, recall, f1: f1(precision, recall) };
}

function cgmCallers(name) {
  try {
    const out = execFileSync("npx", [...CGM, "refs", name, "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const json = JSON.parse(out);
    const files = new Set();
    for (const r of json.references ?? []) {
      if (r.relation === "calls" && r.file_path) files.add(relative(root, resolve(root, r.file_path)));
    }
    return files;
  } catch {
    return new Set();
  }
}

async function main() {
  console.log(`\n=== codescope vs code-graph-mcp — ${relative(process.cwd(), root) || root} ===`);
  const store = new GraphStore(":memory:");
  await new Indexer(store, root).indexAll();
  execFileSync("npx", [...CGM, "rebuild-index", "--confirm"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });

  const agg = { cs: { p: 0, r: 0, f: 0, n: 0 }, cgm: { p: 0, r: 0, f: 0, n: 0 } };
  for (const def of oracle) {
    const truth = new Set(def.callerFiles);
    if (truth.size === 0) continue;
    const cs = score(new Set(store.findCallers(def.name, { limit: 200 }).map((x) => x.file)), truth);
    const cgm = score(cgmCallers(def.name), truth);
    agg.cs.p += cs.precision; agg.cs.r += cs.recall; agg.cs.f += cs.f1; agg.cs.n++;
    agg.cgm.p += cgm.precision; agg.cgm.r += cgm.recall; agg.cgm.f += cgm.f1; agg.cgm.n++;
  }
  store.close();
  const rep = (l, a) => console.log(`  ${l.padEnd(14)} precision=${(a.p / a.n).toFixed(3)}  recall=${(a.r / a.n).toFixed(3)}  F1=${(a.f / a.n).toFixed(3)}  (n=${a.n})`);
  rep("codescope", agg.cs);
  rep("code-graph-mcp", agg.cgm);
  const cs = agg.cs.f / agg.cs.n, cgm = agg.cgm.f / agg.cgm.n;
  console.log(`\n  → ${cs >= cgm ? "codescope ✓" : "code-graph-mcp ✓"}  (F1 ${cs.toFixed(3)} vs ${cgm.toFixed(3)})`);
}

main();
