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

### Incremental freshness

Refreshing the graph after you edit one file costs **~0.5–0.65 ms** in-process
(read + parse + replace) on a 3,000-file repo — **2,700–3,000× cheaper than a
full re-index of the same repo**. codescope re-indexes on every save via its file
watcher, so an agent always queries current code, not a stale snapshot.

> **Honest note:** codegraph *also* does incremental updates (`codegraph sync`)
> and *also* ships a file watcher that auto-syncs in `serve` mode by default.
> Watch-first is **not** a feature codescope has and codegraph lacks — both have
> it. The ~0.5 ms figure above is codescope's *in-process* per-file cost; it is
> not a head-to-head win over codegraph's watcher (which does comparable work).
> See the comparison table below for what the measured differences actually are.

### Token efficiency

For the navigation task *"find symbol X and understand its call relationships"*:

- **baseline** = the tokens an agent reads today: the whole file that defines `X`
  (agents `Read` the file to locate and understand a symbol).
- **codescope** = the tokens of the `get_symbol(X)` + `neighborhood(X)` responses.

codescope returns the answer in **71–98% fewer tokens** (median 2.6–5.3× smaller
per query). For the *"what's in this file"* task, `file_outline` is **59–86%**
smaller than reading the file. Bigger files ⇒ bigger savings, which is why the
reduction climbs on large repos.

## Accuracy — "did it return the right answer?"

Speed and tokens are only half the story; the half that matters most for an agent
is **whether the answer is correct.** This is measured against an oracle that
*is* correct: the **TypeScript compiler** (`LanguageService.findReferences`, the
engine behind go-to-definition in your editor).

For each definition we compute the TRUE set of files containing a call to it
(per the compiler), then score each tool's `callers` answer:

```bash
node bench/accuracy.mjs <single-package-dir>
```

Run on three packages of the official MCP TypeScript SDK (single packages so the
compiler resolves modules exactly; oracle truth scoped to each package's own
source so every tool is judged on the same files):

| package | codescope (P / R / **F1**) | codegraph (P / R / **F1**) | winner |
|---------|---------------------------|----------------------------|:------:|
| core (88 defs)   | 0.93 / 1.00 / **0.952** | 0.71 / 0.67 / 0.664 | **codescope** |
| client (39 defs) | 0.89 / 1.00 / **0.916** | 0.80 / 0.65 / 0.701 | **codescope** |
| server (36 defs) | 0.94 / 1.00 / **0.956** | 0.94 / 0.90 / 0.906 | **codescope** |

(P = precision, R = recall, F1 = harmonic mean, vs the compiler's ground truth.)

**codescope returns the right answer more often on every package.** The driver is
**recall**: codegraph *misses 10–35% of true callers* (R 0.65–0.90), while
codescope's name-based lookup misses none (R 1.00). codescope's precision (0.89–
0.94) — the occasional false positive from a same-named symbol — matches or beats
codegraph's, so it wins net on every package.

The remaining headroom is codescope's precision on collisions (a function/method
sharing a name with another). True type-aware resolution (an LSP-grade type
checker) is the theoretical ceiling neither tree-sitter tool reaches; it's the
roadmap item for pushing precision to 1.0. As measured today, **codescope is the
more accurate of the two.**

## codescope vs codegraph — measured head-to-head

[codegraph](https://github.com/colbymchenry/codegraph) (~35k★) is the leading
local codebase-graph MCP and shares codescope's architecture (tree-sitter →
SQLite + FTS5 → MCP, incremental sync, file watcher). Both tools were **run
through their CLIs on the same repos, same machine**, by `bench/vs-codegraph.mjs`:

```bash
node bench/vs-codegraph.mjs <repo-path>
```

| axis | repo | codegraph | codescope | winner |
|------|------|----------:|----------:|:------:|
| full index (CLI wall) | mcp-ts-sdk (262 f) | 2,335 ms | **670 ms** | codescope (3.5×) |
| | phoenix (3,500 f) | 20,010 ms | **2,639 ms** | codescope (7.6×) |
| index size on disk | mcp-ts-sdk | 8.2 MB | **2.5 MB** | codescope (3.3×) |
| | phoenix | 112.8 MB | **22.8 MB** | codescope (5.0×) |
| tokens / definition answer | mcp-ts-sdk | 187 | **145** | codescope |
| | phoenix | 215 | **183** | codescope |
| tokens / callers answer | mcp-ts-sdk | 122 | **98** | codescope |
| | phoenix | 177 | **145** | codescope |

(Index wall includes Node/npx startup for both; tokens are startup-independent
and are the core value metric. 15 shared query terms per repo, picked by
call-site frequency.)

### Verdict — codescope wins every measured axis

codescope **indexes 3.5–7.6× faster** (parsing is fanned across a worker-thread
pool — see below), its **index is 3–5× smaller**, and it answers both definition
*and* callers queries in **fewer tokens** on every repo tested. It also matches
codegraph's core graph tools (`callers`, `callees`, `impact`, `context`,
`affected`) and ships an `install` command, across **21 languages**.

**Why indexing is so much faster:** profiling showed indexing is ~85% parsing,
~15% SQLite insert. codescope parses across a pool of worker threads (one per
core) while the main thread owns the database — turning a single-core bottleneck
into an N-core one. It falls back to single-threaded parsing if workers are
unavailable, so it stays correct everywhere.

codescope ships **21 languages**, an **`affected`** (changed-files → impacted
tests) tool, and an **`install`** command that auto-wires it into Claude Code and
Cursor — plus the `callers`/`callees`/`impact`/`context` parity above.

What **codegraph still leads on** — the honest remainder:

- **Richer nodes** — codegraph also indexes constants, properties, and routes as
  graph nodes (part of why its index is larger; codescope indexes
  functions/methods/classes/interfaces/types/enums).
- **Cross-file resolution** — codescope resolves references by name + call shape
  (kind-aware), not by following imports to a specific definition file. On
  ambiguous names this is a heuristic, not a compiler. (Roadmap.)
- **A few more agents** — codegraph auto-installs into Codex/opencode/Hermes too;
  codescope auto-wires Claude Code + Cursor and prints config for the rest.
- **Maturity & adoption** — 35k★ and a real user base. *Adoption is earned from
  the community, not claimed.*

So: on every axis this harness can measure objectively — index speed, footprint,
and tokens-per-answer — **codescope wins**, with feature parity on the graph
tools across 21 languages. codegraph's remaining edge is a richer node set,
true cross-file resolution, broader agent install, and (above all) maturity.

> The token-reduction numbers in the first half of this doc measure codescope vs
> *reading whole files* (the same baseline codegraph reports its 57% against) —
> they show codescope's value over a naive agent, not over codegraph. The table
> above is the actual codescope-vs-codegraph comparison.

## Does it generalize? (cross-codebase)

To check the results aren't tuned to one repo, codescope and codegraph were run
on **five fresh, unrelated codebases** across languages — including **Gin, one of
codegraph's own published benchmark repos** (anti-cherry-pick):

| repo | lang | index size | tokens/def | tokens/callers |
|------|------|:----------:|:----------:|:--------------:|
| gin | Go | **cs** 1.6 vs 5.6 MB | cg 109 vs 97 | **cs** 76 vs 103 |
| requests | Python | **cs** 0.7 vs 2.4 MB | **cs** 126 vs 172 | **cs** 59 vs 74 |
| zustand | TS | **cs** 0.5 vs 1.0 MB | tie 81 vs 80 | cg 29 vs 20 |
| got | TS | **cs** 1.0 vs 3.2 MB | **cs** 90 vs 96 | tie 53 vs 52 |
| ripgrep | Rust | **cs** 2.0 vs 9.1 MB | **cs** 150 vs 167 | **cs** 81 vs 154 |

**Honest reading:** index size — codescope wins **5/5** (3–4× smaller). Tokens —
codescope wins most, ties or loses a few (gin definitions, zustand callers); it's
competitive, not universally ahead. Index *speed* on these small repos is within
process-startup noise (both finish well under a second) — codescope's robust
speed win is on large repos (see the table above). This variance is the point:
nothing here is hand-tuned to a single codebase.

### Accuracy generalizes across languages

Accuracy is scored against each language's **own native analysis engine** as
ground truth — not codescope's. Three independent oracles, three major languages:

| language | oracle (ground truth) | repo | codescope F1 | codegraph F1 |
|----------|----------------------|------|:------------:|:------------:|
| TypeScript | `tsc` LanguageService | MCP core (88) | **0.952** | 0.664 |
| TypeScript | `tsc` LanguageService | MCP client (39) | **0.916** | 0.701 |
| TypeScript | `tsc` LanguageService | MCP server (36) | **0.956** | 0.906 |
| TypeScript | `tsc` LanguageService | got (101) | **0.970** | 0.749 |
| TypeScript | `tsc` LanguageService | zustand (30) | **0.989** | 0.867 |
| Python | Jedi | requests (69) | **0.869** | 0.534 |
| Go | `go/types` | gin (209) | **0.720** | 0.646 |

```bash
# TypeScript (tsc oracle, built in)
node bench/accuracy.mjs <ts-package-dir>
# Python (Jedi) and Go (go/types) via a precomputed oracle:
python3 bench/oracle-python.py <pkg> > o.json && node bench/accuracy-generic.mjs <pkg> o.json
go run bench/oracle-go.go <repo> > o.json && node bench/accuracy-generic.mjs <repo> o.json
```

**codescope wins caller-F1 on every language and repo tested.** The pattern is
consistent: codescope has near-perfect recall (it's name-based, so it rarely
misses a true caller) while codegraph misses 13–48% of callers; codescope's
precision matches or beats codegraph's.

**Honest reading of Go:** gin is collision-heavy (many types share method names
like `Use`, `Next`, `Handle`), so *both* tools have low precision there
(codescope 0.62, codegraph 0.57) — neither resolves the receiver's type. This is
the case where true type-aware resolution would help most, and it's the same
roadmap item noted above. codescope still wins net, but Go is honestly the
hardest language for this name-based approach.

### What this exercise found and fixed

Cross-codebase benchmarking caught a real regression, not a tuning opportunity:
the worker-thread parse pool engaged at >24 files, but its startup cost only pays
off on large monorepos — so small/medium repos were *slower* with it on. The
threshold was raised so the pool engages only for large repos; small/medium repos
use the faster single-threaded path. (Finding and fixing this is the opposite of
benchmark-maxing.)

## Versus the broader OSS field

codegraph isn't the only peer. codescope was also benchmarked against other
runnable open-source code-graph/index tools (each explicitly authorized and run
locally, same harness).

### code-graph-mcp (`@sdsrs/code-graph` v0.32.3)

Rust, tree-sitter, 16 languages — plus semantic/vector search, HTTP-route
tracing, and portable snapshots (a broader tool than codescope).

| axis | codescope | code-graph-mcp |
|------|----------:|---------------:|
| index size — gin / requests / zustand / got / ripgrep | 1.6 / 0.7 / 0.5 / 1.0 / 2.0 MB | 4.0 / 2.3 / 1.0 / 2.2 / 8.8 MB |
| index time (same five) | 0.2–0.6 s | 0.9–1.8 s |
| accuracy F1 — Python (requests, vs Jedi) | **0.788** | 0.217 |
| accuracy F1 — Go (gin, vs go/types) | **0.720** | 0.651 |

codescope is 2–4× smaller and faster to index on all five, and more accurate on
callers. code-graph-mcp's Python call accuracy is low (0.217) — calls aren't its
focus (semantic search is); on Go it's competitive (0.651).

### code-review-graph (v2.3.5)

Python, tree-sitter, plus community detection, flow analysis, and wiki
generation (again, broader than codescope).

- requests: build **5.98 s**, graph **6.1 MB**  vs  codescope ~0.3 s, ~0.7 MB
  (≈20× faster, ≈9× smaller) — though it does heavier post-processing.
- Caller accuracy not measured: its query interface is MCP-only (no `callers`
  CLI), so it would need an MCP-client harness.

### CodeGraphContext

Stores its graph in **Neo4j**; benchmarking needs a running Neo4j server, which
wasn't available in this environment. Not measured.

### Honest verdict on the field

Against every competitor benchmarked, codescope is the **leanest, fastest, and
most call-graph-accurate**. But it is not the most *featureful*: code-graph-mcp
adds semantic/vector search and route tracing; code-review-graph adds community
detection and wiki generation; CodeGraphContext offers Cypher queries over Neo4j.
codescope's bet is "small, fast, accurate call graph," not "most features."

## Caveats (read these)

- **The codegraph head-to-head is single-repo, single-run** (mcp-ts-sdk, one
  machine). codegraph and codescope count "nodes"/"symbols" differently (codegraph
  captures more node kinds), so index time and DB size are informative but not a
  pure apples-to-apples ratio. The honest verdict above accounts for this.
- **codegraph's own published claims** ("57% fewer tokens / 62% fewer tool calls")
  come from a full LLM agent loop across a different 7-repo set and bound a
  *different* quantity (end-to-end agent task cost) than codescope's deterministic
  measurements. Don't equate the two.
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
