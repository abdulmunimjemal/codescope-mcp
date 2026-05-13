#!/usr/bin/env node
// codescope benchmark harness.
//
// Measures the things that actually matter for a codebase-graph MCP server and
// that can be measured deterministically, without an LLM or network:
//   1. Full-index throughput (files/s, symbols/s) and on-disk size.
//   2. Incremental re-index latency — the differentiator: cost to refresh a
//      single changed file vs. a full re-scan.
//   3. Query latency for the MCP tools.
//   4. Token efficiency vs the realistic agent baseline (read the whole file)
//      for the navigation tasks codescope answers from the graph.
//
// Usage: node bench/run.mjs <repo-path> [<repo-path> ...]
// Output: a human-readable table on stdout; pass --md <file> to also write a
// Markdown report.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { encode } from "gpt-tokenizer";
import { GraphStore } from "../dist/index.js";
import { Indexer } from "../dist/index.js";
import { languageForPath } from "../dist/index.js";
import { parseSource } from "../dist/index.js";
import * as fmt from "../dist/index.js";

const TOKENS = (s) => (s ? encode(s).length : 0);

function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms, sub-ms precision
}

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function sample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

async function benchRepo(repoPath) {
  const root = resolve(repoPath);
  const dbPath = join(mkdtempSync(join(tmpdir(), "cs-bench-")), "graph.db");
  const store = new GraphStore(dbPath);
  const indexer = new Indexer(store, root);

  // 1. Full index ----------------------------------------------------------
  const t0 = now();
  const run = await indexer.indexAll();
  const indexMs = now() - t0;
  const stats = store.stats();
  const dbBytes = statSync(dbPath).size;

  // 2. Incremental re-index latency ---------------------------------------
  // Cost to refresh ONE changed file = read + parse + replace. We measure it
  // across a sample of real files (using their actual current content).
  const files = store.listFiles();
  const incrementalMs = [];
  for (const rel of sample(files, 250)) {
    const abs = join(root, rel);
    const lang = languageForPath(abs);
    if (!lang) continue;
    let content;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const start = now();
    const parsed = await parseSource(lang.id, content);
    store.replaceFile(
      { path: rel, lang: lang.id, hash: `bench-${start}`, size: content.length, mtime: 0 },
      parsed.symbols,
      parsed.refs,
      0,
    );
    incrementalMs.push(now() - start);
  }

  // 3. Query latency -------------------------------------------------------
  const names = sampleSymbolNames(store, 300);
  const queryLatency = {
    search: timeQueries(names, (n) => store.searchSymbols(n.slice(0, 5), { limit: 20 })),
    get: timeQueries(names, (n) => store.getSymbol(n)),
    callers: timeQueries(names, (n) => store.findCallers(n, { limit: 50 })),
    neighborhood: timeQueries(names, (n) => store.neighborhood(n, { depth: 2 })),
  };

  // 4. Token efficiency vs read-the-whole-file baseline --------------------
  const tokenStats = await tokenEfficiency(store, root, 150);

  store.close();
  rmSync(join(dbPath, ".."), { recursive: true, force: true });

  return {
    repo: basename(root),
    root,
    files: stats.files,
    symbols: stats.symbols,
    refs: stats.refs,
    langs: stats.byLang,
    indexMs,
    dbBytes,
    indexErrors: run.errors.length,
    filesPerSec: stats.files / (indexMs / 1000),
    symbolsPerSec: stats.symbols / (indexMs / 1000),
    incremental: {
      count: incrementalMs.length,
      p50: pct(incrementalMs, 50),
      p95: pct(incrementalMs, 95),
      mean: mean(incrementalMs),
    },
    queryLatency,
    tokenStats,
  };
}

function sampleSymbolNames(store, n) {
  const rows = store.db
    .prepare(
      "SELECT DISTINCT name FROM symbols WHERE kind IN ('function','method','class') AND length(name) >= 4 LIMIT 5000",
    )
    .all();
  return sample(rows.map((r) => r.name), n);
}

function timeQueries(names, fn) {
  if (names.length === 0) return { mean: 0, p95: 0 };
  const times = [];
  for (const n of names) {
    const start = now();
    fn(n);
    times.push(now() - start);
  }
  return { mean: mean(times), p95: pct(times, 95) };
}

async function tokenEfficiency(store, root, n) {
  // For each sampled symbol, compare the tokens an agent reads to answer
  // "where is X and what does it relate to":
  //   baseline   = the whole file that defines X (what an agent Reads today)
  //   codescope  = get_symbol(X) + neighborhood(X) responses
  const rows = store.db
    .prepare(
      `SELECT s.name, f.path FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.kind IN ('function','method','class') AND length(s.name) >= 4`,
    )
    .all();
  const picks = sample(rows, n);

  let baselineTotal = 0;
  let codescopeTotal = 0;
  let outlineBaselineTotal = 0;
  let outlineTotal = 0;
  const ratios = [];
  const fileCache = new Map();

  for (const { name, path } of picks) {
    let fileText = fileCache.get(path);
    if (fileText === undefined) {
      try {
        fileText = await readFile(join(root, path), "utf8");
      } catch {
        fileText = "";
      }
      fileCache.set(path, fileText);
    }
    if (!fileText) continue;

    const fileTokens = TOKENS(fileText);

    // Navigation task: locate + understand a symbol and its call relations.
    const answer =
      fmt.format.formatSymbols(store.getSymbol(name)) +
      "\n" +
      fmt.format.formatNeighborhood(store.neighborhood(name, { depth: 2 }));
    const answerTokens = TOKENS(answer);

    baselineTotal += fileTokens;
    codescopeTotal += answerTokens;
    if (answerTokens > 0) ratios.push(fileTokens / answerTokens);

    // File-shape task: "what's in this file" — outline vs reading the file.
    const outline = fmt.format.formatSymbols(store.fileOutline(path));
    outlineBaselineTotal += fileTokens;
    outlineTotal += TOKENS(outline);
  }

  return {
    samples: ratios.length,
    navBaselineTokens: baselineTotal,
    navCodescopeTokens: codescopeTotal,
    navReductionPct: baselineTotal ? (1 - codescopeTotal / baselineTotal) * 100 : 0,
    navMedianFactor: pct(ratios, 50),
    outlineReductionPct: outlineBaselineTotal
      ? (1 - outlineTotal / outlineBaselineTotal) * 100
      : 0,
  };
}

function fmtBytes(b) {
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b > 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function printResult(r) {
  const langs = Object.entries(r.langs)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  console.log(`\n━━━ ${r.repo} ━━━`);
  console.log(`  files=${r.files}  symbols=${r.symbols}  refs=${r.refs}  (${langs})`);
  console.log(
    `  full index:     ${r.indexMs.toFixed(0)} ms   ` +
      `(${r.filesPerSec.toFixed(0)} files/s, ${r.symbolsPerSec.toFixed(0)} symbols/s)  db=${fmtBytes(r.dbBytes)}`,
  );
  console.log(
    `  incremental:    p50=${r.incremental.p50.toFixed(2)} ms  p95=${r.incremental.p95.toFixed(2)} ms  ` +
      `mean=${r.incremental.mean.toFixed(2)} ms   (${(r.indexMs / r.incremental.mean).toFixed(0)}× faster than full re-index)`,
  );
  console.log(
    `  query latency:  search=${r.queryLatency.search.mean.toFixed(3)}ms  get=${r.queryLatency.get.mean.toFixed(3)}ms  ` +
      `callers=${r.queryLatency.callers.mean.toFixed(3)}ms  neighborhood=${r.queryLatency.neighborhood.mean.toFixed(3)}ms`,
  );
  console.log(
    `  token savings:  nav task ${r.tokenStats.navReductionPct.toFixed(1)}% fewer tokens ` +
      `(median ${r.tokenStats.navMedianFactor.toFixed(1)}× smaller), file-outline ${r.tokenStats.outlineReductionPct.toFixed(1)}% fewer  ` +
      `[n=${r.tokenStats.samples}]`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  let mdPath;
  const repos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--md") mdPath = args[++i];
    else repos.push(args[i]);
  }
  if (repos.length === 0) {
    console.error("usage: node bench/run.mjs <repo-path> [<repo-path> ...] [--md report.md]");
    process.exit(1);
  }

  const results = [];
  for (const repo of repos) {
    try {
      const r = await benchRepo(repo);
      printResult(r);
      results.push(r);
    } catch (err) {
      console.error(`failed on ${repo}: ${err?.stack ?? err}`);
    }
  }

  if (mdPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(mdPath, renderMarkdown(results));
    console.log(`\nwrote ${mdPath}`);
  }
}

function renderMarkdown(results) {
  const rows = results
    .map(
      (r) =>
        `| ${r.repo} | ${r.files} | ${r.symbols} | ${r.indexMs.toFixed(0)} ms | ${r.filesPerSec.toFixed(0)} | ` +
        `${r.incremental.mean.toFixed(2)} ms | ${(r.indexMs / r.incremental.mean).toFixed(0)}× | ` +
        `${r.queryLatency.neighborhood.mean.toFixed(2)} ms | ${r.tokenStats.navReductionPct.toFixed(0)}% |`,
    )
    .join("\n");
  return `<!-- generated by bench/run.mjs -->
| repo | files | symbols | full index | files/s | incremental (mean) | speedup | neighborhood query | token reduction |
|------|------:|--------:|-----------:|--------:|-------------------:|--------:|-------------------:|----------------:|
${rows}
`;
}

main();
