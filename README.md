# codescope

> Local-first codebase knowledge-graph MCP server. Parses your repo into a symbol
> graph and serves it to AI coding agents so they stop wasting tokens re-scanning
> files. **Watch-first:** the graph stays fresh as you type.

Coding agents (Claude Code, Cursor, Codex, …) burn tokens and tool calls
re-discovering your codebase — `grep` for a name, `read` the whole file, `grep`
again for the callers, `read` those files too. codescope indexes the repo once
into a local SQLite graph and answers "where is `X`, what calls it, what's in
this file" in a handful of tokens and a single tool call — then keeps the graph
current by re-indexing each file the instant you save it.

100% local. No API keys, no network, no telemetry.

## Why not just grep?

`grep` finds *text*; codescope understands *structure*. It knows that `run` is a
method on `Service`, that `loadConfig` is called from three places, and that a
bare `parse()` call is a different thing from `obj.parse()`. It returns
`file:line` + signatures, not raw matches — and it returns a bounded **call
neighbourhood** (callers + callees, a few hops out) so an agent gets the relevant
slice of the codebase for a change without opening a dozen files.

See [BENCHMARKS.md](./BENCHMARKS.md): on a 2,500-file repo, codescope answers a
navigation query in **~70–98% fewer tokens** than reading the file, and refreshes
a changed file in **~0.5 ms** — roughly **3,000× cheaper than a full re-index**.

## How it compares to codegraph

[codegraph](https://github.com/colbymchenry/codegraph) (~35k★) is the mature
incumbent and shares codescope's architecture. In a **measured head-to-head**
([BENCHMARKS.md](./BENCHMARKS.md), both tools run on the same repos), codescope
**wins the efficiency axes**:

- **3.5–7.6× faster indexing** (670 ms vs 2,335 ms on 262 files; 2.6 s vs 20 s on 3,500) — parsing is fanned across a worker-thread pool.
- **3–5× smaller index** on disk (2.5 MB vs 8.2 MB; 22.8 MB vs 112.8 MB).
- **Fewer tokens per answer** — on *both* definition and callers queries, every repo tested.
- **Feature parity:** `callers`, `callees`, `impact`, `context`, **`affected`** (test-impact), and **`install`** (agent auto-wiring) — across **21 languages**.

codegraph still leads on **maturity & adoption** (35k★, a real user base), a few
extra node kinds (constants, properties, routes), and true cross-file resolution.
Pick codescope when footprint, index speed, and token cost matter; pick codegraph
for the most battle-tested option. Full numbers in [BENCHMARKS.md](./BENCHMARKS.md).

## Install

```bash
npx @abdulmunimjemal/codescope mcp .          # zero-install, or:
npm i -g @abdulmunimjemal/codescope           # then the `codescope` command is on your PATH
```

Requires Node ≥ 18. (The npm package is scoped because the bare name `codescope`
collides with an existing package; the installed command is still `codescope`.)

## Quick start

The one-liner — wire codescope into your agents automatically, from your repo:

```bash
npx @abdulmunimjemal/codescope install     # adds codescope to Claude Code + Cursor
```

That writes the MCP server config (non-destructively) so your agent launches
codescope on the repo. Restart the agent and you're done. `--agent claude|cursor`
targets one; `--global` writes to your home dir instead of the project.

Prefer to wire it by hand? The server command is:

```bash
codescope mcp /path/to/your/repo            # index, watch, and serve over stdio
```

**Claude Code** (`.mcp.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "codescope": { "command": "npx", "args": ["-y", "@abdulmunimjemal/codescope", "mcp", "."] }
  }
}
```

**Cursor / Codex / any MCP client:** use the same command —
`npx -y @abdulmunimjemal/codescope mcp .` over stdio.

You can also drive it straight from the terminal:

```bash
codescope index .                       # build the graph, print stats
codescope search useState               # fuzzy symbol search
codescope get GraphStore                # jump to a definition
codescope callers parseSource           # who calls this
codescope callees indexAll              # what it calls
codescope impact GraphStore             # blast radius before a change
codescope context "auth flow"           # ranked relevance map for a task
codescope affected src/store.ts         # which tests are affected by a change
codescope neighborhood handleRequest --depth 3
codescope watch .                       # keep the graph fresh, log updates
```

## MCP tools

| tool | what it answers |
|------|-----------------|
| `search_symbols(query, kind?, limit?)` | fuzzy substring search over definitions — use instead of grep/glob |
| `get_symbol(name, limit?)` | jump to a definition by exact name (kind, `file:line`, signature) |
| `find_callers(name, limit?)` | who calls this function/method (distinct callers) |
| `find_callees(name, limit?)` | what this symbol calls — its outgoing dependencies |
| `impact(name, depth?, limit?)` | transitive callers (blast radius) before you change something |
| `context(query, maxSymbols?)` | a ranked relevance map for a task — matches + neighbours, the fastest way to orient |
| `find_references(name, kind?, limit?)` | all calls + imports of a name |
| `file_outline(path)` | every symbol in a file, in order — a compact alternative to reading it |
| `neighborhood(name, depth?, limit?)` | the call neighbourhood (callers + callees) around a symbol, as a subgraph |
| `stats()` | counts for the indexed graph |

Tool descriptions are written *for the agent* — they nudge it to query the graph
instead of scanning files.

## How it works

1. **Parse.** Every supported file is parsed with [tree-sitter](https://tree-sitter.github.io)
   (WASM grammars, no native build) into definitions (functions, methods,
   classes, interfaces, types, enums) and references (calls, imports).
2. **Store.** Symbols and references go into a local SQLite database with a
   trigram FTS5 index for fast substring search. References are stored **by name**
   and resolved to definitions lazily at query time — so changing one file never
   invalidates another's data.
3. **Resolve.** Calls are resolved **kind-aware**: a bare `foo()` resolves to a
   *function* named `foo`, while `x.foo()` resolves to a *method* named `foo`.
   This avoids the classic name-collision explosion (e.g. a project that happens
   to define a function called `push`). Ambiguous, library-ish names are left
   unresolved rather than blowing up the graph.
4. **Watch.** A file watcher re-indexes each file on save in sub-millisecond
   time. Because updates are per-file and content-hash gated, the graph is always
   current and a re-scan skips everything that hasn't changed.

The index lives in `.codescope/graph.db` (add `.codescope/` to your
`.gitignore`). codescope respects your repo's `.gitignore` when indexing.

## Languages

21 languages: TypeScript, JavaScript, TSX/JSX, Python, Go, Rust, Java, Ruby, C,
C++, C#, PHP, Scala, Solidity, Zig, Kotlin, Objective-C, Lua, Bash, OCaml, and
ReScript. Definition extraction (functions, classes, methods, …) works for all;
call and import edges are available for the languages whose grammars expose them.

## Programmatic API

Everything is importable:

```ts
import { GraphStore, Indexer, watch, parseSource } from "codescope";

const store = new GraphStore("graph.db");      // or ":memory:"
const indexer = new Indexer(store, "/repo");
await indexer.indexAll();

store.searchSymbols("config");
store.neighborhood("handleRequest", { depth: 2 });

watch(indexer, { onChange: (file, action) => console.log(action, file) });
```

## Limitations

- References resolve by **name + call shape**, not full type/scope analysis. It is
  a fast heuristic graph, not a compiler. Cross-file import resolution is not yet
  modelled.
- Rust `impl` methods are currently labelled `function` (impl blocks aren't tracked
  as containers).
- Symbol extraction targets top-level and class-member definitions; deeply nested
  local helpers are captured, anonymous expressions are not.

## License

MIT © Abdulmunim Jemal
