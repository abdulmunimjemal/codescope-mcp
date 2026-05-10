/**
 * codescope — local-first codebase knowledge-graph MCP server.
 *
 * Public library surface. The CLI ({@link ./cli.ts}) is the usual entry point,
 * but everything here is importable for programmatic use and testing.
 */
export { GraphStore, type FileMeta } from "./store.js";
export { Indexer, type IndexOptions, type FileIndexOutcome } from "./indexer.js";
export { watch, type WatchEvents, type WatchHandle, type WatchOptions } from "./watcher.js";
export { parseSource } from "./parser.js";
export {
  LANGUAGES,
  SUPPORTED_EXTENSIONS,
  languageForPath,
  type LanguageConfig,
} from "./languages.js";
export { createServer, runStdioServer } from "./mcp.js";
export * as format from "./format.js";
export { VERSION } from "./version.js";
export type * from "./types.js";
