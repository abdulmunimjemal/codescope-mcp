# Contributing to codescope

Thanks for considering a contribution — codescope is small, well-tested, and
designed to be easy to extend. This guide gets you from clone to merged PR.

## Quick start

```bash
git clone https://github.com/abdulmunimjemal/codescope.git
cd codescope
pnpm install
pnpm test          # 100+ vitest tests, no network
pnpm typecheck     # tsc --noEmit (strict)
pnpm build         # tsup → dist/
```

Requires Node ≥ 18 and pnpm. That's the whole setup — there's no service to run,
no API key, no database to provision. Tests never touch the network, a real
agent, or real git: they use in-memory SQLite and code fixtures.

Dogfood your change against a real repo:

```bash
node dist/cli.js index .         # build the graph
node dist/cli.js search <name>   # query it
node bench/run.mjs .             # performance numbers
```

## Project layout

| Path | What it is |
|------|-----------|
| `src/parser.ts` | tree-sitter walk → symbols + references |
| `src/languages.ts` | per-language config tables (defs / calls / imports) |
| `src/store.ts` | SQLite graph + queries (search, callers, neighborhood, …) |
| `src/indexer.ts` | repo walk, content-hash gating, parallel parse pool |
| `src/parse-pool.ts` / `parse-worker.ts` | worker-thread parsing |
| `src/watcher.ts` | chokidar incremental re-index |
| `src/mcp.ts` | the MCP server + tools |
| `src/affected.ts` / `install.ts` | test-impact and agent auto-install |
| `src/cli.ts` | the `codescope` command |
| `bench/` | reproducible benchmarks (incl. `vs-codegraph.mjs`, `accuracy.mjs`) |

## Adding a language (a great first contribution)

Languages are **pure configuration** — no new parser code. Most additions are a
single object in `src/languages.ts` plus a test case.

1. **Check the grammar loads.** codescope uses `web-tree-sitter@0.24.x`, which
   supports tree-sitter ABI 13–14. Grammars from `tree-sitter-wasms` that target
   ABI 12 or 15 will throw or crash — probe in an isolated process first:

   ```bash
   node -e "(async()=>{const P=require('web-tree-sitter');await P.init();await P.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-LANG.wasm'));console.log('ok')})()"
   ```

2. **Inspect the AST** for a sample file to learn the node-type names:

   ```bash
   node -e "(async()=>{const P=require('web-tree-sitter');await P.init();const L=await P.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-LANG.wasm'));const p=new P();p.setLanguage(L);console.log(p.parse('YOUR SAMPLE').rootNode.toString())})()"
   ```

3. **Add a `LanguageConfig`** mapping definition node types → symbol kinds, and
   describing how calls and imports are shaped. The name-extraction strategies
   (`field`, `first_typed`, `c_declarator`) cover grammars with and without a
   `name` field. Add the file extensions to `EXT_TO_LANG`.

4. **Add a test case** to `test/languages.test.ts` asserting the expected
   symbols (and calls/imports where the grammar exposes them).

Definitions are the bar — calls/imports are best-effort per grammar. A language
that only extracts definitions is still a useful, mergeable contribution.

## Pull requests

- **One concern per PR.** A bugfix, a language, or a feature — not all three.
- **Keep it tested.** Add or update tests; `pnpm test`, `pnpm typecheck`, and
  `pnpm build` must all pass (CI runs the same).
- **Match the surrounding style** — the code is strict TypeScript with terse,
  purposeful comments. No reformatting unrelated code.
- **Commit messages**: conventional-commit style (`feat:`, `fix:`, `docs:`,
  `perf:`, `test:`, `chore:`), imperative mood, lowercase summary.
- Describe *what* and *why* in the PR; link an issue if one exists.

## Good places to start

- **Add a language** (see above) — the most self-contained contribution.
- **Improve call/import extraction** for a language that currently does
  definitions only (Lua, Bash, OCaml, Kotlin calls).
- **Cross-file resolution** — resolve an imported callee to its specific
  definition file to raise precision (see the roadmap in the README).
- Pick up anything labelled [`good first issue`](https://github.com/abdulmunimjemal/codescope/labels/good%20first%20issue).

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it.
