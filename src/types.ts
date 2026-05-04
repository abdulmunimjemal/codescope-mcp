/**
 * Shared types for the codescope knowledge graph.
 *
 * The graph has two node-bearing concepts:
 *  - {@link ParsedSymbol}: a *definition* (function, class, method, …).
 *  - {@link ParsedRef}: a *reference* from inside one symbol to a name
 *    (a call, an import specifier, …). References are stored by name and
 *    resolved to definitions lazily at query time — this is what keeps
 *    incremental re-indexing cheap: changing one file never invalidates
 *    another file's stored data.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable";

/**
 * `call`   — a bare-identifier call, `foo()`.
 * `method` — a member/attribute call, `obj.foo()`.
 * `import` — a module specifier.
 *
 * Splitting `call` from `method` lets the graph resolve callees by *kind*
 * (a bare call resolves to a function; a method call resolves to a method),
 * which avoids the classic name-collision explosion when, say, a project
 * happens to define a function named `push`.
 */
export type RefKind = "call" | "method" | "import";

/** A definition extracted from a source file, before it is given a row id. */
export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** Enclosing symbol name (e.g. the class for a method), if any. */
  container: string | null;
  exported: boolean;
  /** A one-line, whitespace-collapsed signature (declaration up to the body). */
  signature: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  startByte: number;
  endByte: number;
}

/** A reference (call / import) extracted from a source file. */
export interface ParsedRef {
  /** The symbol the reference appears inside, if any. */
  fromSymbol: string | null;
  /** The referenced identifier (callee) or module specifier (import). */
  name: string;
  kind: RefKind;
  startRow: number;
  startCol: number;
}

/** The result of parsing a single source file. */
export interface ParseResult {
  lang: string;
  symbols: ParsedSymbol[];
  refs: ParsedRef[];
}

/** A stored definition, as returned by graph queries (carries its file path). */
export interface SymbolRow {
  id: number;
  file: string;
  name: string;
  kind: SymbolKind;
  container: string | null;
  exported: boolean;
  signature: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** A stored reference, as returned by graph queries. */
export interface RefRow {
  id: number;
  file: string;
  fromSymbol: string | null;
  name: string;
  kind: RefKind;
  startRow: number;
  startCol: number;
}

/** A compact neighbourhood subgraph around a symbol. */
export interface Neighborhood {
  root: string;
  /** Definitions reachable within the requested depth, keyed by name. */
  nodes: SymbolRow[];
  /** Directed call edges (caller → callee) among the included names. */
  edges: Array<{ from: string; to: string }>;
  /** Names referenced in the graph that have no definition in the index. */
  unresolved: string[];
}

export interface IndexStats {
  files: number;
  symbols: number;
  refs: number;
  byKind: Record<string, number>;
  byLang: Record<string, number>;
}

export interface IndexRunResult {
  indexed: number;
  skipped: number;
  removed: number;
  errors: Array<{ file: string; error: string }>;
  durationMs: number;
}
