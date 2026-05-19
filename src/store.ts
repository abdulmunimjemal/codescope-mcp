import Database from "better-sqlite3";
import type {
  ContextBundle,
  ImpactRow,
  IndexStats,
  Neighborhood,
  ParsedRef,
  ParsedSymbol,
  RefRow,
  SymbolKind,
  SymbolRow,
} from "./types.js";

export interface FileMeta {
  path: string;
  lang: string;
  hash: string;
  size: number;
  mtime: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  lang       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  container  TEXT,
  exported   INTEGER NOT NULL DEFAULT 0,
  signature  TEXT,
  start_row  INTEGER NOT NULL,
  start_col  INTEGER NOT NULL,
  end_row    INTEGER NOT NULL,
  end_col    INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refs (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_symbol TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_row   INTEGER NOT NULL,
  start_col   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_from ON refs(from_symbol);

-- Trigram FTS index for fast substring symbol search at scale. Kept in sync
-- manually (rowid = symbols.id) so it survives the per-file replace/delete path.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, tokenize='trigram');
`;

interface SymbolDbRow {
  id: number;
  file: string;
  name: string;
  kind: string;
  container: string | null;
  exported: number;
  signature: string | null;
  start_row: number;
  start_col: number;
  end_row: number;
  end_col: number;
}

interface RefDbRow {
  id: number;
  file: string;
  from_symbol: string | null;
  name: string;
  kind: string;
  start_row: number;
  start_col: number;
}

const SYMBOL_COLUMNS = `
  s.id, f.path AS file, s.name, s.kind, s.container, s.exported, s.signature,
  s.start_row, s.start_col, s.end_row, s.end_col`;

/**
 * The on-disk (or in-memory) code graph. All writes go through
 * {@link GraphStore.replaceFile} / {@link GraphStore.removeFile}, which operate
 * on a single file at a time so incremental updates stay O(file), not O(repo).
 */
export class GraphStore {
  readonly db: Database.Database;

  constructor(location = ":memory:") {
    this.db = new Database(location);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** The content hash of an already-indexed file, if present. */
  getFileHash(path: string): string | undefined {
    const row = this.db
      .prepare<[string], { hash: string }>("SELECT hash FROM files WHERE path = ?")
      .get(path);
    return row?.hash;
  }

  /** All indexed file paths. */
  listFiles(): string[] {
    return this.db
      .prepare<[], { path: string }>("SELECT path FROM files ORDER BY path")
      .all()
      .map((r) => r.path);
  }

  /** Insert or replace a file and all of its symbols/refs in one transaction. */
  replaceFile(meta: FileMeta, symbols: ParsedSymbol[], refs: ParsedRef[], now: number): void {
    this.transaction(() => {
      this.dropFtsForFile(meta.path);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(meta.path);
      const fileId = Number(
        this.db
          .prepare(
            "INSERT INTO files (path, lang, hash, size, mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(meta.path, meta.lang, meta.hash, meta.size, meta.mtime, now).lastInsertRowid,
      );

      const insSym = this.db.prepare(
        `INSERT INTO symbols
           (file_id, name, kind, container, exported, signature,
            start_row, start_col, end_row, end_col, start_byte, end_byte)
         VALUES (@file_id, @name, @kind, @container, @exported, @signature,
                 @start_row, @start_col, @end_row, @end_col, @start_byte, @end_byte)`,
      );
      const insFts = this.db.prepare("INSERT INTO symbols_fts(rowid, name) VALUES (?, ?)");
      for (const s of symbols) {
        const symId = insSym.run({
          file_id: fileId,
          name: s.name,
          kind: s.kind,
          container: s.container,
          exported: s.exported ? 1 : 0,
          signature: s.signature,
          start_row: s.startRow,
          start_col: s.startCol,
          end_row: s.endRow,
          end_col: s.endCol,
          start_byte: s.startByte,
          end_byte: s.endByte,
        }).lastInsertRowid;
        insFts.run(symId, s.name);
      }

      const insRef = this.db.prepare(
        `INSERT INTO refs (file_id, from_symbol, name, kind, start_row, start_col)
         VALUES (@file_id, @from_symbol, @name, @kind, @start_row, @start_col)`,
      );
      for (const r of refs) {
        insRef.run({
          file_id: fileId,
          from_symbol: r.fromSymbol,
          name: r.name,
          kind: r.kind,
          start_row: r.startRow,
          start_col: r.startCol,
        });
      }
    });
  }

  /** Remove a file and its symbols/refs. Returns true if anything was deleted. */
  removeFile(path: string): boolean {
    return this.transactionResult(() => {
      this.dropFtsForFile(path);
      return this.db.prepare("DELETE FROM files WHERE path = ?").run(path).changes > 0;
    });
  }

  /** Remove the FTS rows for a file's current symbols (call before deleting it). */
  private dropFtsForFile(path: string): void {
    const ids = this.db
      .prepare<[string], { id: number }>(
        "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?",
      )
      .all(path);
    if (ids.length === 0) return;
    const del = this.db.prepare("DELETE FROM symbols_fts WHERE rowid = ?");
    for (const { id } of ids) del.run(id);
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * Fuzzy substring search over symbol names. Queries of 3+ characters use the
   * trigram FTS index (fast at scale); shorter queries fall back to LIKE since
   * trigram matching needs at least three characters.
   */
  searchSymbols(query: string, opts: { kind?: SymbolKind; limit?: number } = {}): SymbolRow[] {
    const limit = clampLimit(opts.limit);
    if (query.trim().length >= 3) {
      const match = `"${query.replace(/"/g, '""')}"`;
      const rows = opts.kind
        ? this.db
            .prepare<[string, string, number], SymbolDbRow>(
              `SELECT ${SYMBOL_COLUMNS} FROM symbols_fts ft
               JOIN symbols s ON s.id = ft.rowid JOIN files f ON f.id = s.file_id
               WHERE symbols_fts MATCH ? AND s.kind = ?
               ORDER BY s.exported DESC, length(s.name), s.name LIMIT ?`,
            )
            .all(match, opts.kind, limit)
        : this.db
            .prepare<[string, number], SymbolDbRow>(
              `SELECT ${SYMBOL_COLUMNS} FROM symbols_fts ft
               JOIN symbols s ON s.id = ft.rowid JOIN files f ON f.id = s.file_id
               WHERE symbols_fts MATCH ?
               ORDER BY s.exported DESC, length(s.name), s.name LIMIT ?`,
            )
            .all(match, limit);
      return rows.map(toSymbolRow);
    }

    const like = `%${escapeLike(query)}%`;
    const rows = opts.kind
      ? this.db
          .prepare<[string, string, number], SymbolDbRow>(
            `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE s.name LIKE ? ESCAPE '\\' AND s.kind = ?
             ORDER BY s.exported DESC, length(s.name), s.name LIMIT ?`,
          )
          .all(like, opts.kind, limit)
      : this.db
          .prepare<[string, number], SymbolDbRow>(
            `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE s.name LIKE ? ESCAPE '\\'
             ORDER BY s.exported DESC, length(s.name), s.name LIMIT ?`,
          )
          .all(like, limit);
    return rows.map(toSymbolRow);
  }

  /** Exact-name definition lookup. */
  getSymbol(name: string, opts: { limit?: number } = {}): SymbolRow[] {
    return this.db
      .prepare<[string, number], SymbolDbRow>(
        `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name = ? ORDER BY s.exported DESC, f.path LIMIT ?`,
      )
      .all(name, clampLimit(opts.limit))
      .map(toSymbolRow);
  }

  /**
   * Distinct callers of a name (both bare `foo()` and `x.foo()`). Multiple call
   * sites from the same caller in the same file collapse to one row — fewer
   * tokens and a more useful "who depends on this" answer.
   */
  findCallers(name: string, opts: { limit?: number } = {}): RefRow[] {
    return this.db
      .prepare<[string, number], RefDbRow>(
        `SELECT MIN(r.id) AS id, f.path AS file, r.from_symbol, r.name,
                MIN(r.kind) AS kind, MIN(r.start_row) AS start_row, MIN(r.start_col) AS start_col
         FROM refs r JOIN files f ON f.id = r.file_id
         WHERE r.name = ? AND r.kind IN ('call', 'method')
         GROUP BY f.path, r.from_symbol
         ORDER BY f.path, start_row LIMIT ?`,
      )
      .all(name, clampLimit(opts.limit))
      .map(toRefRow);
  }

  /** The definitions that a symbol calls, resolved kind-aware to project symbols. */
  findCallees(name: string, opts: { limit?: number } = {}): SymbolRow[] {
    const limit = clampLimit(opts.limit);
    const out: SymbolRow[] = [];
    const seen = new Set<string>();
    for (const callee of this.calleesOf(name)) {
      const defs = this.resolveCallee(callee.name, callee.kind, 6);
      if (!defs) continue;
      for (const d of defs) {
        const key = `${d.name}@${d.file}:${d.startRow}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(d);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  /** How many call sites reference this name (popularity / centrality signal). */
  callerCount(name: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM refs WHERE name = ? AND kind IN ('call','method')",
        )
        .get(name)?.n ?? 0
    );
  }

  /**
   * The blast radius of changing a symbol: its transitive callers, breadth-first,
   * annotated with hop distance and ordered nearest-first. Answers "what could
   * break if I change this?" without reading the codebase.
   */
  impact(name: string, opts: { depth?: number; limit?: number } = {}): ImpactRow[] {
    const depth = Math.max(1, Math.min(opts.depth ?? 3, 6));
    const limit = clampLimit(opts.limit, 300);
    const distance = new Map<string, number>([[name, 0]]);
    let frontier = [name];
    for (let d = 0; d < depth && frontier.length > 0 && distance.size < limit; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const caller of this.callersOf(node)) {
          if (!distance.has(caller)) {
            distance.set(caller, d + 1);
            next.push(caller);
          }
        }
      }
      frontier = next;
    }
    const out: ImpactRow[] = [];
    for (const [n, dist] of distance) {
      if (dist === 0) continue; // exclude the symbol itself
      for (const def of this.getSymbol(n, { limit: 3 })) out.push({ ...def, distance: dist });
    }
    out.sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
    return out.slice(0, limit);
  }

  /**
   * A token-budgeted relevance map for a task: the symbols matching `query` plus
   * their immediate call neighbourhood, ranked by call-site centrality, capped at
   * `maxSymbols`. This is the slice of the codebase an agent needs to start a
   * change — delivered as graph facts, not file dumps.
   */
  context(query: string, opts: { maxSymbols?: number } = {}): ContextBundle {
    const maxSymbols = Math.max(5, Math.min(opts.maxSymbols ?? 30, 100));
    const seeds = this.searchSymbols(query, { limit: Math.min(8, maxSymbols) });
    const picked = new Map<string, SymbolRow>();
    const key = (s: SymbolRow): string => `${s.name}@${s.file}:${s.startRow}`;
    for (const s of seeds) picked.set(key(s), s);

    // Gather neighbours of each seed, ranked by how widely they are called.
    const candidates = new Map<string, { row: SymbolRow; score: number }>();
    const edges: Array<{ from: string; to: string }> = [];
    const edgeKeys = new Set<string>();
    for (const seed of seeds) {
      for (const callee of this.findCallees(seed.name, { limit: 15 })) {
        addEdge(edges, edgeKeys, seed.name, callee.name);
        const k = key(callee);
        if (!picked.has(k) && !candidates.has(k)) {
          candidates.set(k, { row: callee, score: this.callerCount(callee.name) });
        }
      }
      for (const caller of this.findCallers(seed.name, { limit: 15 })) {
        if (!caller.fromSymbol) continue;
        addEdge(edges, edgeKeys, caller.fromSymbol, seed.name);
        for (const def of this.getSymbol(caller.fromSymbol, { limit: 1 })) {
          const k = key(def);
          if (!picked.has(k) && !candidates.has(k)) {
            candidates.set(k, { row: def, score: this.callerCount(def.name) });
          }
        }
      }
    }

    const related = [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, maxSymbols - picked.size))
      .map((c) => c.row);

    const keptNames = new Set([...seeds, ...related].map((s) => s.name));
    return {
      query,
      seeds,
      related,
      edges: edges.filter((e) => keptNames.has(e.from) && keptNames.has(e.to)),
    };
  }

  /** All references (calls + imports) to a name. */
  findReferences(
    name: string,
    opts: { kind?: "call" | "method" | "import"; limit?: number } = {},
  ): RefRow[] {
    const limit = clampLimit(opts.limit);
    const rows = opts.kind
      ? this.db
          .prepare<[string, string, number], RefDbRow>(
            `SELECT r.id, f.path AS file, r.from_symbol, r.name, r.kind, r.start_row, r.start_col
             FROM refs r JOIN files f ON f.id = r.file_id
             WHERE r.name = ? AND r.kind = ? ORDER BY f.path, r.start_row LIMIT ?`,
          )
          .all(name, opts.kind, limit)
      : this.db
          .prepare<[string, number], RefDbRow>(
            `SELECT r.id, f.path AS file, r.from_symbol, r.name, r.kind, r.start_row, r.start_col
             FROM refs r JOIN files f ON f.id = r.file_id
             WHERE r.name = ? ORDER BY f.path, r.start_row LIMIT ?`,
          )
          .all(name, limit);
    return rows.map(toRefRow);
  }

  /** The symbols defined in a file, in source order. */
  fileOutline(path: string): SymbolRow[] {
    return this.db
      .prepare<[string], SymbolDbRow>(
        `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ? ORDER BY s.start_row, s.start_col`,
      )
      .all(path)
      .map(toSymbolRow);
  }

  /** Distinct (callee, callKind) pairs invoked from inside symbols named `from`. */
  private calleesOf(from: string): Array<{ name: string; kind: "call" | "method" }> {
    return this.db
      .prepare<[string], { name: string; kind: "call" | "method" }>(
        "SELECT DISTINCT name, kind FROM refs WHERE from_symbol = ? AND kind IN ('call','method')",
      )
      .all(from);
  }

  /** Distinct caller symbol names that invoke `name`. */
  private callersOf(name: string): string[] {
    return this.db
      .prepare<[string], { from_symbol: string }>(
        "SELECT DISTINCT from_symbol FROM refs WHERE name = ? AND kind IN ('call','method') AND from_symbol IS NOT NULL",
      )
      .all(name)
      .map((r) => r.from_symbol);
  }

  /**
   * Resolve a callee name to project definitions, honouring how it was called:
   * a bare `foo()` resolves to non-method symbols, an `x.foo()` resolves to
   * methods. Ambiguous names (more than `ambiguityCap` definitions — typically
   * library-ish names like `push`/`map`) are treated as unresolved so they
   * don't blow up the neighbourhood. Returns `null` when nothing resolves.
   */
  private resolveCallee(
    name: string,
    callKind: "call" | "method",
    ambiguityCap: number,
  ): SymbolRow[] | null {
    const defs = this.getSymbol(name, { limit: ambiguityCap + 1 }).filter((d) =>
      callKind === "method" ? d.kind === "method" : d.kind !== "method",
    );
    if (defs.length === 0 || defs.length > ambiguityCap) return null;
    return defs;
  }

  /**
   * A bounded call neighbourhood around `name`: callers and callees expanded
   * breadth-first up to `depth`. Only edges between *resolvable project
   * symbols* are followed, so the result is the relevant slice of the codebase
   * — the payload a coding agent reads instead of grepping the whole repo.
   */
  neighborhood(
    name: string,
    opts: { depth?: number; limit?: number; maxFanout?: number; ambiguityCap?: number } = {},
  ): Neighborhood {
    const depth = Math.max(1, Math.min(opts.depth ?? 2, 5));
    const limit = clampLimit(opts.limit, 200);
    const maxFanout = opts.maxFanout ?? 25;
    const ambiguityCap = opts.ambiguityCap ?? 4;

    const seen = new Set<string>([name]);
    const edges: Array<{ from: string; to: string }> = [];
    const edgeKeys = new Set<string>();
    let frontier = [name];

    for (let d = 0; d < depth && frontier.length > 0 && seen.size < limit; d++) {
      const next = new Set<string>();
      for (const node of frontier) {
        let fanout = 0;
        for (const callee of this.calleesOf(node)) {
          if (fanout >= maxFanout) break;
          if (!this.resolveCallee(callee.name, callee.kind, ambiguityCap)) continue;
          fanout++;
          addEdge(edges, edgeKeys, node, callee.name);
          if (!seen.has(callee.name) && seen.size < limit) {
            seen.add(callee.name);
            next.add(callee.name);
          }
        }
        let callerFanout = 0;
        for (const caller of this.callersOf(node)) {
          if (callerFanout >= maxFanout) break;
          callerFanout++;
          addEdge(edges, edgeKeys, caller, node);
          if (!seen.has(caller) && seen.size < limit) {
            seen.add(caller);
            next.add(caller);
          }
        }
      }
      frontier = [...next];
    }

    const nodes: SymbolRow[] = [];
    const unresolved: string[] = [];
    for (const n of seen) {
      const defs = this.getSymbol(n, { limit: 5 });
      if (defs.length > 0) nodes.push(...defs);
      else unresolved.push(n);
    }
    return { root: name, nodes, edges, unresolved };
  }

  /** Aggregate counts for the whole graph. */
  stats(): IndexStats {
    const files = this.count("SELECT COUNT(*) AS n FROM files");
    const symbols = this.count("SELECT COUNT(*) AS n FROM symbols");
    const refs = this.count("SELECT COUNT(*) AS n FROM refs");
    const byKind: Record<string, number> = {};
    for (const r of this.db
      .prepare<[], { kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind",
      )
      .all()) {
      byKind[r.kind] = r.n;
    }
    const byLang: Record<string, number> = {};
    for (const r of this.db
      .prepare<[], { lang: string; n: number }>(
        "SELECT lang, COUNT(*) AS n FROM files GROUP BY lang",
      )
      .all()) {
      byLang[r.lang] = r.n;
    }
    return { files, symbols, refs, byKind, byLang };
  }

  close(): void {
    this.db.close();
  }

  private count(sql: string): number {
    return this.db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
  }

  private transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  private transactionResult<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function addEdge(
  edges: Array<{ from: string; to: string }>,
  keys: Set<string>,
  from: string,
  to: string,
): void {
  const key = `${from} ${to}`;
  if (!keys.has(key)) {
    keys.add(key);
    edges.push({ from, to });
  }
}

function clampLimit(limit: number | undefined, max = 500): number {
  if (!limit || limit <= 0) return 50;
  return Math.min(limit, max);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toSymbolRow(r: SymbolDbRow): SymbolRow {
  return {
    id: r.id,
    file: r.file,
    name: r.name,
    kind: r.kind as SymbolKind,
    container: r.container,
    exported: r.exported === 1,
    signature: r.signature,
    startRow: r.start_row,
    startCol: r.start_col,
    endRow: r.end_row,
    endCol: r.end_col,
  };
}

function toRefRow(r: RefDbRow): RefRow {
  return {
    id: r.id,
    file: r.file,
    fromSymbol: r.from_symbol,
    name: r.name,
    kind: r.kind as RefRow["kind"],
    startRow: r.start_row,
    startCol: r.start_col,
  };
}
