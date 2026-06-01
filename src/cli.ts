#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { affected } from "./affected.js";
import * as fmt from "./format.js";
import { Indexer } from "./indexer.js";
import { type AgentId, SUPPORTED_AGENTS, codexSnippet, install } from "./install.js";
import { runStdioServer } from "./mcp.js";
import { GraphStore } from "./store.js";
import type { SymbolKind } from "./types.js";
import { VERSION } from "./version.js";
import { watch } from "./watcher.js";

interface Flags {
  positional: string[];
  path?: string;
  db?: string;
  memory: boolean;
  kind?: string;
  limit?: number;
  depth?: number;
  agent?: string;
  global: boolean;
}

const HELP = `codescope ${VERSION} — local-first codebase knowledge-graph MCP server

Usage:
  codescope <command> [path] [options]

Commands:
  install [path]          Wire codescope into your agents (Claude Code, Cursor) automatically.
  mcp [path]              Index, watch for changes, and serve the graph over MCP (stdio).
                          This is what you wire into Claude Code / Cursor / Codex.
  index [path]            Build (or refresh) the on-disk graph and print stats.
  watch [path]            Index, then keep the graph fresh as files change (logs updates).
  stats [path]            Show counts for the indexed graph.
  search <query> [path]   Fuzzy-search symbol names.
  get <name> [path]       Look up a definition by exact name.
  callers <name> [path]   List callers of a function/method.
  callees <name> [path]   List what a function/method calls.
  impact <name> [path]    Transitive callers (blast radius) of a symbol.
  context <query> [path]  Ranked relevance map for a task (matches + neighbours).
  affected <files...>     Test files affected by a set of changed files.
  neighborhood <name>     Show the call neighbourhood around a symbol.

Options:
  --agent <name>          install target: claude | cursor | all (default all).
  --global                install: write to your home dir instead of the project.
  --path <dir>            Repository root (default: current directory or the positional path).
  --db <file>            SQLite graph location (default: <root>/.codescope/graph.db).
  --memory               Use an in-memory graph (not persisted).
  --kind <kind>          Restrict search to: function|method|class|interface|type|enum|variable.
  --limit <n>            Max results (default 50).
  --depth <n>            neighbourhood hops (default 2).
  -h, --help             Show this help.
  -v, --version          Show version.

Examples:
  codescope index .
  codescope search useState
  codescope neighborhood handleRequest --depth 3
  codescope mcp .            # add this command to your agent's MCP config
`;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [], memory: false, global: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--memory":
        flags.memory = true;
        break;
      case "--global":
        flags.global = true;
        break;
      case "--agent":
        flags.agent = argv[++i];
        break;
      case "--path":
        flags.path = argv[++i];
        break;
      case "--db":
        flags.db = argv[++i];
        break;
      case "--kind":
        flags.kind = argv[++i];
        break;
      case "--limit":
        flags.limit = Number(argv[++i]);
        break;
      case "--depth":
        flags.depth = Number(argv[++i]);
        break;
      default:
        flags.positional.push(arg);
    }
  }
  return flags;
}

function rootDir(flags: Flags, positionalRootIndex = 0): string {
  return resolve(flags.path ?? flags.positional[positionalRootIndex] ?? ".");
}

function openStore(root: string, flags: Flags): GraphStore {
  if (flags.memory) return new GraphStore(":memory:");
  const dir = resolve(root, ".codescope");
  mkdirSync(dir, { recursive: true });
  return new GraphStore(flags.db ?? resolve(dir, "graph.db"));
}

/** Ensure the graph is populated; index on demand for query commands. */
async function ensureIndexed(indexer: Indexer, store: GraphStore): Promise<void> {
  if (store.stats().files === 0) {
    await indexer.indexAll();
  }
}

async function cmdIndex(root: string, flags: Flags): Promise<void> {
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  process.stderr.write(pc.dim(`Indexing ${root} …\n`));
  const result = await indexer.indexAll();
  const { files, symbols, refs } = store.stats();
  process.stdout.write(
    `${pc.green("✓")} indexed ${pc.bold(String(result.indexed))} files ` +
      `(${result.skipped} unchanged, ${result.removed} removed) in ${result.durationMs}ms\n` +
      `  ${files} files · ${symbols} symbols · ${refs} refs\n`,
  );
  if (result.errors.length > 0) {
    process.stderr.write(pc.yellow(`  ${result.errors.length} file(s) failed to parse\n`));
  }
  store.close();
}

async function cmdStats(root: string, flags: Flags): Promise<void> {
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  await ensureIndexed(indexer, store);
  process.stdout.write(`${fmt.formatStats(store.stats())}\n`);
  store.close();
}

async function cmdQuery(command: string, root: string, flags: Flags): Promise<void> {
  const term = flags.positional[0];
  if (!term) fail(`'${command}' needs an argument. See --help.`);
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  await ensureIndexed(indexer, store);

  let out: string;
  switch (command) {
    case "search":
      out = fmt.formatSymbols(
        store.searchSymbols(term, { kind: flags.kind as SymbolKind | undefined, limit: flags.limit }),
      );
      break;
    case "get":
      out = fmt.formatSymbols(store.getSymbol(term, { limit: flags.limit }));
      break;
    case "callers":
      out = fmt.formatCallers(store.findCallers(term, { limit: flags.limit }));
      break;
    case "callees":
      out = fmt.formatSymbols(store.findCallees(term, { limit: flags.limit }));
      break;
    case "impact":
      out = fmt.formatImpact(store.impact(term, { depth: flags.depth, limit: flags.limit }));
      break;
    case "context":
      out = fmt.formatContext(store.context(term, { maxSymbols: flags.limit }));
      break;
    case "neighborhood":
      out = fmt.formatNeighborhood(store.neighborhood(term, { depth: flags.depth, limit: flags.limit }));
      break;
    default:
      out = "";
  }
  process.stdout.write(`${out}\n`);
  store.close();
}

async function cmdAffected(root: string, flags: Flags): Promise<void> {
  const files = flags.positional;
  if (files.length === 0) fail("'affected' needs one or more changed file paths. See --help.");
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  await ensureIndexed(indexer, store);
  // Accept absolute or relative paths; normalise to the repo-relative graph key.
  const rels = files.map((f) => indexer.rel(resolve(root, f)));
  process.stdout.write(`${fmt.formatAffected(affected(store, rels, { depth: flags.depth }))}\n`);
  store.close();
}

function cmdInstall(root: string, flags: Flags): void {
  const agents: AgentId[] =
    !flags.agent || flags.agent === "all"
      ? [...SUPPORTED_AGENTS]
      : SUPPORTED_AGENTS.includes(flags.agent as AgentId)
        ? [flags.agent as AgentId]
        : fail(`unknown --agent '${flags.agent}'. Use: ${SUPPORTED_AGENTS.join(", ")}, or all.`);

  const results = install(root, { agents, global: flags.global });
  for (const r of results) {
    process.stdout.write(`${pc.green("✓")} ${r.action} codescope for ${pc.bold(r.agent)} → ${r.path}\n`);
  }
  process.stdout.write(
    `\n${pc.dim("Restart your agent to pick up the change.")}\n` +
      `${pc.dim("Codex (TOML config) — add this to ~/.codex/config.toml:")}\n${codexSnippet()}\n`,
  );
}

async function cmdWatch(root: string, flags: Flags): Promise<void> {
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  process.stderr.write(pc.dim(`Indexing ${root} …\n`));
  await indexer.indexAll();
  process.stderr.write(`${pc.green("✓")} watching for changes (ctrl-c to stop)\n`);
  watch(indexer, {
    onChange: (rel, action) =>
      process.stderr.write(`${action === "indexed" ? pc.cyan("↻") : pc.red("✗")} ${rel}\n`),
    onError: (err) => process.stderr.write(pc.yellow(`watch error: ${String(err)}\n`)),
  });
  await new Promise(() => {}); // run until interrupted
}

async function cmdMcp(root: string, flags: Flags): Promise<void> {
  // stdout is the MCP transport — every human-readable byte must go to stderr.
  const store = openStore(root, flags);
  const indexer = new Indexer(store, root);
  process.stderr.write(pc.dim(`codescope: indexing ${root} …\n`));
  const result = await indexer.indexAll();
  process.stderr.write(
    pc.dim(`codescope: ${result.indexed} files indexed, watching for changes\n`),
  );
  watch(indexer, {
    onChange: (rel, action) => process.stderr.write(pc.dim(`codescope: ${action} ${rel}\n`)),
    onError: (err) => process.stderr.write(pc.yellow(`codescope: watch error ${String(err)}\n`)),
  });
  await runStdioServer(store);
}

function fail(message: string): never {
  process.stderr.write(`${pc.red("error:")} ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const command = argv[0] as string;
  const flags = parseArgs(argv.slice(1));

  switch (command) {
    case "index":
      return cmdIndex(rootDir(flags), flags);
    case "stats":
      return cmdStats(rootDir(flags), flags);
    case "search":
    case "get":
    case "callers":
    case "callees":
    case "impact":
    case "context":
    case "neighborhood":
      // positional[0] is the term; the optional repo path is positional[1].
      return cmdQuery(command, resolve(flags.path ?? flags.positional[1] ?? "."), flags);
    case "affected":
      // all positionals are changed files; repo root comes from --path or cwd.
      return cmdAffected(resolve(flags.path ?? "."), flags);
    case "install":
      return cmdInstall(rootDir(flags), flags);
    case "watch":
      return cmdWatch(rootDir(flags), flags);
    case "mcp":
      return cmdMcp(rootDir(flags), flags);
    default:
      fail(`unknown command '${command}'. See --help.`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
