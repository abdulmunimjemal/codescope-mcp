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
| full index (CLI wall) | mcp-ts-sdk (262 f) | 2,855 ms | **696 ms** | codescope (4.1×) |
| | phoenix (3,500 f) | 20,139 ms | **5,199 ms** | codescope (3.9×) |
| index size on disk | mcp-ts-sdk | 8.2 MB | **2.5 MB** | codescope (3.3×) |
| | phoenix | 112.8 MB | **22.9 MB** | codescope (4.9×) |
| tokens / definition answer | mcp-ts-sdk | 187 | **148** | codescope |
| | phoenix | 215 | **183** | codescope |
| tokens / callers answer | mcp-ts-sdk | 139 | **126** | codescope |
| | phoenix | **177** | 188 | codegraph (≈parity) |

(Index wall includes Node/npx startup for both; tokens are startup-independent
and are the core value metric. 15 shared query terms per repo, picked by
call-site frequency.)

### Honest verdict

On the **measured efficiency axes, codescope wins**: it indexes **~4× faster**,
its index is **3–5× smaller**, and it answers definition lookups in **fewer
tokens** on every repo tested. Callers answers are a wash — codescope wins on the
TypeScript repo and trails ~6% on the Python monorepo (long file paths), so call
it parity. codescope also now matches codegraph's **core graph tools**
(`callers`, `callees`, `impact`, `context`).

codescope has since closed the feature gaps it could: it now ships **20
languages**, an **`affected`** (changed-files → impacted tests) tool, and an
**`install`** command that auto-wires it into Claude Code and Cursor — plus the
`callers`/`callees`/`impact`/`context` parity above.

What **codegraph still leads on**, and codescope does not claim to beat:

- **Richer nodes** — codegraph also indexes constants, properties, and routes as
  graph nodes (part of why its index is larger).
- **A couple more languages / agents** — codegraph advertises 20+ languages and
  auto-installs into more agents (Codex, opencode, Hermes); codescope auto-wires
  Claude Code + Cursor and prints copy-paste config for the rest.
- **Maturity & adoption** — 35k★, a real user base, and battle-testing codescope
  can't match on day one. *Adoption is earned from the community, not claimed.*

So: **codescope is faster, smaller, and more token-efficient, with parity on the
graph queries, `affected`, and agent install across 20 languages; codegraph's
remaining edge is maturity and a slightly wider surface.** Pick codescope when
footprint, indexing speed, and token cost matter; pick codegraph for the most
battle-tested option.

> The token-reduction numbers in the first half of this doc measure codescope vs
> *reading whole files* (the same baseline codegraph reports its 57% against) —
> they show codescope's value over a naive agent, not over codegraph. The table
> above is the actual codescope-vs-codegraph comparison.

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
