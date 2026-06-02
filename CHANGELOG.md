# Changelog

All notable changes to codescope are documented here. This project adheres to
[Semantic Versioning](https://semver.org) (pre-1.0: minor = features, patch =
fixes/docs).

## 0.5.1

- The GitHub repo was renamed to **`codescope-mcp`** to match the npm package
  (GitHub redirects the old URL). Updated repository/homepage/bug-tracker
  metadata, badges, and clone instructions accordingly.

## 0.5.0 — renamed on npm

- Published unscoped as **`codescope-mcp`** instead of
  `@abdulmunimjemal/codescope` (the bare `codescope` name is taken on npm). The
  CLI command (`codescope`), repository, and docs are unchanged — only the npm
  install id differs. The old scoped package is deprecated and points here.
- The `install` command now writes `npx -y codescope-mcp …` into agent configs.

## 0.4.2

- **Fix:** the worker-thread parse pool engaged too eagerly (>24 files); its
  startup cost made small/medium repos *slower*. Raised the threshold so the pool
  only runs on large monorepos — small/medium repos use the faster single-threaded
  path. Found via cross-codebase benchmarking (gin, requests, zustand, got,
  ripgrep). See BENCHMARKS.md → "Does it generalize?".

## 0.4.1

- Publish the accuracy-documented README (callers accuracy measured against the
  TypeScript compiler as ground truth).

## 0.4.0 — performance

- **Parallel parsing** via a worker-thread pool (parsing is ~85% of index time);
  ~2–3× faster full index on large repos, with a single-threaded fallback.
- SQLite write tuning (WAL + `synchronous=NORMAL`, larger cache, mmap).
- Callers output grouped by file — fewer tokens, easier to scan.
- Added **ReScript** (21 languages); generalized bare-call extraction so any
  leaf-identifier grammar yields call edges.

## 0.3.0 — coverage & tooling

- Expanded to **20 languages** (Scala, Solidity, Zig, Kotlin, Objective-C, Lua,
  Bash, OCaml).
- `affected` — given changed files, find the impacted test files (call-graph +
  import-graph reachability).
- `install` — auto-wire codescope into Claude Code and Cursor MCP configs.

## 0.2.0 — graph tools

- `callees`, `impact` (transitive blast radius), and `context` (token-budgeted
  task relevance map) tools, with call-site centrality ranking.
- Leaner, lower-token output across tools.

## 0.1.0 — first release

- Local codebase knowledge-graph MCP server: tree-sitter → SQLite + FTS5 → MCP.
- Tools: `search_symbols`, `get_symbol`, `find_callers`, `find_references`,
  `file_outline`, `neighborhood`, `stats`.
- Watch-first incremental indexing; 12 languages (TS/JS/TSX, Python, Go, Rust,
  Java, Ruby, C, C++, C#, PHP).
