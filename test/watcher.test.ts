import { mkdtempSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.js";
import { GraphStore } from "../src/store.js";
import { watch, type WatchHandle } from "../src/watcher.js";

let dir: string;
let store: GraphStore;
let indexer: Indexer;
let handle: WatchHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codescope-watch-"));
  store = new GraphStore(":memory:");
  indexer = new Indexer(store, dir);
});

afterEach(async () => {
  await handle?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Resolve once `predicate()` is true, polling until `timeout` ms. */
async function until(predicate: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function ready(h: WatchHandle, isReady: () => boolean): Promise<void> {
  void h;
  return until(isReady);
}

describe("watch (polling mode for determinism)", () => {
  it("indexes a newly created file", async () => {
    let isReady = false;
    handle = watch(indexer, { onReady: () => (isReady = true) }, { usePolling: true, interval: 30 });
    await ready(handle, () => isReady);

    await writeFile(join(dir, "new.ts"), "export function fresh() {}");
    await until(() => store.getSymbol("fresh").length === 1);
    expect(store.getSymbol("fresh")).toHaveLength(1);
  });

  it("re-indexes a changed file and removes a deleted one", async () => {
    await writeFile(join(dir, "a.ts"), "export function alpha() {}");
    await indexer.indexAll();

    let isReady = false;
    handle = watch(indexer, { onReady: () => (isReady = true) }, { usePolling: true, interval: 30 });
    await ready(handle, () => isReady);

    await writeFile(join(dir, "a.ts"), "export function beta() {}");
    await until(() => store.getSymbol("beta").length === 1 && store.getSymbol("alpha").length === 0);

    await rm(join(dir, "a.ts"));
    await until(() => store.listFiles().length === 0);
    expect(store.getSymbol("beta")).toHaveLength(0);
  });
});
