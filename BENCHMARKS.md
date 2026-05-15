# Benchmarks

These numbers come from `bench/run.mjs` and measure the things that matter for a
codebase-graph MCP server **and that can be measured deterministically** — no
LLM, no network, fully reproducible:

```bash
pnpm build
node bench/run.mjs <repo-path> [<repo-path> ...] [--md report.md]
```

Measured on an Apple Silicon laptop, Node 25, 2026-06-01, on four real
repositories (this repo plus three large open-source codebases checked out
locally). Your absolute numbers will vary with hardware; the **ratios** are the
point.

## Results

| repo | files | symbols | refs | full index | throughput | incremental p50 | speedup vs full | search | neighborhood | nav token reduction |
|------|------:|--------:|-----:|-----------:|-----------:|----------------:|----------------:|-------:|-------------:|--------------------:|
| codescope | 22 | 123 | 1,163 | 64 ms | 346 files/s | **1.94 ms** | 18× | 0.04 ms | 0.92 ms | 74.5% |
| mcp-ts-sdk | 262 | 1,956 | 23,881 | 495 ms | 529 files/s | **0.58 ms** | 281× | 0.06 ms | 0.92 ms | 71.1% |
| phoenix | 3,500 | 20,135 | 133,530 | 4.7 s | 740 files/s | **0.54 ms** | 2,738× | 0.18 ms | 0.97 ms | 77.3% |
| trigger.dev | 2,481 | 33,784 | 142,472 | 5.8 s | 424 files/s | **0.65 ms** | 2,978× | 0.14 ms | 1.51 ms | 98.4% |

(`phoenix` and `trigger.dev` are multi-language: TypeScript, TSX, Python, Go,
JavaScript — all indexed in a single pass.)

### The headline: incremental freshness

The whole bet behind codescope is **watch-first**. Refreshing the graph after you
edit one file costs **~0.5–0.65 ms** (read + parse + replace) on a 3,000-file
repo — **2,700–3,000× cheaper than a full re-index**. That is what makes "the
graph is never stale" practical: codescope re-indexes on every save in well under
a frame, so an agent always queries the current code, not a snapshot from when
you started the session.

### Token efficiency

For the navigation task *"find symbol X and understand its call relationships"*:

- **baseline** = the tokens an agent reads today: the whole file that defines `X`
  (agents `Read` the file to locate and understand a symbol).
- **codescope** = the tokens of the `get_symbol(X)` + `neighborhood(X)` responses.

codescope returns the answer in **71–98% fewer tokens** (median 2.6–5.3× smaller
per query). For the *"what's in this file"* task, `file_outline` is **59–86%**
smaller than reading the file. Bigger files ⇒ bigger savings, which is why the
reduction climbs on large repos.

## How codescope compares to codegraph (the SOTA)

[codegraph](https://github.com/colbymchenry/codegraph) (~35k★) is the leading
local codebase-graph MCP and shares codescope's architecture (tree-sitter →
SQLite + FTS5 → MCP). **It was not executed for these benchmarks** — running an
unvetted third-party package was outside this environment's sandbox — so the
comparison below is on **published claims and documented architecture**, while
all codescope numbers above are **measured**. Treat this section as directional,
not a measured head-to-head.

| dimension | codegraph (published / documented) | codescope (measured) |
|-----------|-----------------------------------|----------------------|
| token reduction vs baseline | "57% fewer tokens" avg (vendor) | 71–98% on nav tasks |
| tool-call reduction | "62% fewer tool calls" (vendor) | 1 query replaces grep + N×read |
| freshness model | re-index / re-scan | **per-save incremental, ~0.5 ms** |
| search | SQLite FTS5 | SQLite FTS5 (trigram substring) |
| languages | 20+ | 12 (TS/JS/TSX, Py, Go, Rust, Java, Ruby, C, C++, C#, PHP) |
| storage | `.codegraph/codegraph.db` | `.codescope/graph.db`, 100% local |
| install | `npx @colbymchenry/codegraph` | `npx codescope` |

**Where codescope aims to win:** the incremental/watch-first freshness wedge
(quantified above) and matching-or-better token reduction. **Where codegraph
leads today:** breadth (20+ languages) and a large, proven user base. codescope's
honest position is "smaller, fresher, and easy to verify," not "more features."

## Caveats (read these)

- **codegraph numbers are the vendor's**, across a different 7-repo set, measured
  with a full LLM agent loop. They are not directly comparable to codescope's
  deterministic measurements — they bound a *different* quantity (end-to-end agent
  task cost). Don't read the table as "codescope beat codegraph by X%."
- **Token baseline is a model**, not a trace of a real agent: it assumes the agent
  reads the whole containing file, which is the documented failure mode but not
  the only possible behaviour.
- **References resolve by name**, not by full type/scope analysis. Bare calls
  resolve to functions and `x.f()` to methods (kind-aware), and ambiguous
  library-ish names are deliberately not expanded — but this is heuristic, not a
  compiler. Cross-file import resolution is not yet modelled.
- **Rust `impl` methods** are currently labelled `function` (impl blocks aren't
  tracked as containers). Tracked as a known limitation.
- Numbers are single-run on one machine; `bench/run.mjs` samples up to 250 files
  for incremental latency and 150 symbols for token stats.
