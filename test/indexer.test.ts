import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.js";
import { GraphStore } from "../src/store.js";

let dir: string;
let store: GraphStore;
let indexer: Indexer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codescope-idx-"));
  store = new GraphStore(":memory:");
  indexer = new Indexer(store, dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

describe("Indexer.indexAll", () => {
  it("indexes supported files and ignores unsupported ones", async () => {
    await write("src/a.ts", "export function a() { return b(); }");
    await write("src/b.py", "def py_fn():\n    pass\n");
    await write("README.md", "# not code");
    await write("data.json", "{}");

    const result = await indexer.indexAll();
    expect(result.indexed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(store.stats().files).toBe(2);
    expect(store.getSymbol("a")).toHaveLength(1);
    expect(store.getSymbol("py_fn")).toHaveLength(1);
  });

  it("uses POSIX-relative paths as graph keys", async () => {
    await write("src/nested/c.ts", "export const c = () => 1;");
    await indexer.indexAll();
    expect(store.listFiles()).toContain("src/nested/c.ts");
  });

  it("skips unchanged files on re-index (content-hash gated)", async () => {
    await write("a.ts", "export function a() {}");
    const first = await indexer.indexAll();
    expect(first.indexed).toBe(1);

    const second = await indexer.indexAll();
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("re-indexes a changed file and prunes a deleted one", async () => {
    await write("a.ts", "export function alpha() {}");
    await write("b.ts", "export function beta() {}");
    await indexer.indexAll();
    expect(store.getSymbol("alpha")).toHaveLength(1);

    // change a.ts, delete b.ts
    await write("a.ts", "export function gamma() {}");
    await rm(join(dir, "b.ts"));
    const result = await indexer.indexAll();

    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(1);
    expect(store.getSymbol("alpha")).toHaveLength(0);
    expect(store.getSymbol("gamma")).toHaveLength(1);
    expect(store.getSymbol("beta")).toHaveLength(0);
  });

  it("respects the repo .gitignore", async () => {
    await write(".gitignore", "ignored/\n");
    await write("ignored/secret.ts", "export function secret() {}");
    await write("kept.ts", "export function kept() {}");

    await indexer.indexAll();
    expect(store.getSymbol("kept")).toHaveLength(1);
    expect(store.getSymbol("secret")).toHaveLength(0);
  });

  it("can be told to ignore the .gitignore", async () => {
    await write(".gitignore", "ignored/\n");
    await write("ignored/secret.ts", "export function secret() {}");
    await indexer.indexAll({ gitignore: false });
    expect(store.getSymbol("secret")).toHaveLength(1);
  });
});

describe("Indexer.indexFile", () => {
  it("reports indexed / skipped / unsupported outcomes", async () => {
    await write("a.ts", "export function a() {}");
    await write("note.txt", "hi");
    const abs = join(dir, "a.ts");

    expect(await indexer.indexFile(abs)).toBe("indexed");
    expect(await indexer.indexFile(abs)).toBe("skipped");
    expect(await indexer.indexFile(join(dir, "note.txt"))).toBe("unsupported");
  });
});
