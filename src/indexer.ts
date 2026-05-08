import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { glob } from "tinyglobby";
import { SUPPORTED_EXTENSIONS, languageForPath } from "./languages.js";
import { parseSource } from "./parser.js";
import type { GraphStore } from "./store.js";
import type { IndexRunResult } from "./types.js";

/** Directories never worth indexing, regardless of .gitignore. */
const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.codescope/**",
  "**/.next/**",
  "**/out/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/vendor/**",
  "**/__pycache__/**",
];

export interface IndexOptions {
  /** Extra glob patterns to ignore. */
  ignore?: string[];
  /** Honour the repo's root `.gitignore` (default: true). */
  gitignore?: boolean;
}

export type FileIndexOutcome = "indexed" | "skipped" | "unsupported";

/**
 * Walks a repository and keeps a {@link GraphStore} in sync with it. Every
 * operation is per-file and content-hash gated, so a full re-scan skips
 * unchanged files and a single-file update touches only that file.
 */
export class Indexer {
  readonly root: string;

  constructor(
    private readonly store: GraphStore,
    root: string,
  ) {
    this.root = resolve(root);
  }

  /** Index every supported, non-ignored file and prune deleted ones. */
  async indexAll(opts: IndexOptions = {}): Promise<IndexRunResult> {
    const start = Date.now();
    const result: IndexRunResult = {
      indexed: 0,
      skipped: 0,
      removed: 0,
      errors: [],
      durationMs: 0,
    };

    const files = await this.listSourceFiles(opts);
    const present = new Set<string>();

    for (const abs of files) {
      present.add(this.rel(abs));
      try {
        const outcome = await this.indexFile(abs, start);
        if (outcome === "indexed") result.indexed++;
        else if (outcome === "skipped") result.skipped++;
      } catch (err) {
        result.errors.push({ file: this.rel(abs), error: errorMessage(err) });
      }
    }

    for (const known of this.store.listFiles()) {
      if (!present.has(known) && this.store.removeFile(known)) result.removed++;
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  /** Index a single file by absolute path. Cheap when the content is unchanged. */
  async indexFile(abs: string, now = Date.now()): Promise<FileIndexOutcome> {
    const lang = languageForPath(abs);
    if (!lang) return "unsupported";

    const rel = this.rel(abs);
    const content = await readFile(abs, "utf8");
    const hash = sha1(content);
    if (this.store.getFileHash(rel) === hash) return "skipped";

    const mtime = await fileMtime(abs, now);
    const { symbols, refs } = await parseSource(lang.id, content);
    this.store.replaceFile(
      { path: rel, lang: lang.id, hash, size: content.length, mtime },
      symbols,
      refs,
      now,
    );
    return "indexed";
  }

  /** Drop a file from the graph by absolute path. */
  removeFile(abs: string): boolean {
    return this.store.removeFile(this.rel(abs));
  }

  /** Repo-relative, POSIX-separated path used as the stable graph key. */
  rel(abs: string): string {
    return relative(this.root, resolve(abs)).split(sep).join("/");
  }

  private async listSourceFiles(opts: IndexOptions): Promise<string[]> {
    const patterns = SUPPORTED_EXTENSIONS.map((ext) => `**/*${ext}`);
    const files = await glob(patterns, {
      cwd: this.root,
      absolute: true,
      ignore: [...DEFAULT_IGNORES, ...(opts.ignore ?? [])],
      dot: false,
    });

    if (opts.gitignore === false) return files;
    const ig = this.loadGitignore();
    if (!ig) return files;
    return files.filter((f) => {
      const rel = this.rel(f);
      return rel.length > 0 && !ig.ignores(rel);
    });
  }

  private loadGitignore(): Ignore | null {
    try {
      const content = readFileSync(resolve(this.root, ".gitignore"), "utf8");
      return ignore().add(content);
    } catch {
      return null;
    }
  }
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

async function fileMtime(abs: string, fallback: number): Promise<number> {
  try {
    const st = await stat(abs);
    return Math.floor(st.mtimeMs);
  } catch {
    return fallback;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
