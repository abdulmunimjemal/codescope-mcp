import { beforeEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/store.js";
import type { ParsedRef, ParsedSymbol } from "../src/types.js";

function sym(partial: Partial<ParsedSymbol> & { name: string; kind: ParsedSymbol["kind"] }): ParsedSymbol {
  return {
    container: null,
    exported: false,
    signature: null,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    startByte: 0,
    endByte: 0,
    ...partial,
  };
}

function ref(partial: Partial<ParsedRef> & { name: string; kind: ParsedRef["kind"] }): ParsedRef {
  return { fromSymbol: null, startRow: 0, startCol: 0, ...partial };
}

describe("GraphStore", () => {
  let store: GraphStore;
  beforeEach(() => {
    store = new GraphStore(":memory:");
  });

  it("stores and searches symbols", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h1", size: 1, mtime: 0 },
      [sym({ name: "loadConfig", kind: "function", exported: true }), sym({ name: "Config", kind: "interface" })],
      [],
      1,
    );
    const hits = store.searchSymbols("config");
    expect(hits.map((h) => h.name).sort()).toEqual(["Config", "loadConfig"]);
    expect(store.searchSymbols("config", { kind: "interface" }).map((h) => h.name)).toEqual(["Config"]);
    expect(store.getSymbol("loadConfig")[0]?.file).toBe("a.ts");
  });

  it("escapes LIKE wildcards in search", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [sym({ name: "percent", kind: "function" }), sym({ name: "a_b", kind: "function" })],
      [],
      1,
    );
    // '%' must match literally, not as a wildcard
    expect(store.searchSymbols("%")).toHaveLength(0);
    expect(store.searchSymbols("_")).toHaveLength(1); // matches a_b literally
  });

  it("resolves callers and references", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [sym({ name: "main", kind: "function" }), sym({ name: "helper", kind: "function" })],
      [
        ref({ name: "helper", kind: "call", fromSymbol: "main" }),
        ref({ name: "lodash", kind: "import" }),
      ],
      1,
    );
    expect(store.findCallers("helper").map((r) => r.fromSymbol)).toEqual(["main"]);
    expect(store.findReferences("lodash", { kind: "import" })).toHaveLength(1);
  });

  it("builds a kind-aware neighbourhood that ignores name collisions", () => {
    // A function `push` and a method-call `.push()` must not be conflated.
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [
        sym({ name: "main", kind: "function" }),
        sym({ name: "helper", kind: "function" }),
        sym({ name: "push", kind: "function" }), // a real function named push
      ],
      [
        ref({ name: "helper", kind: "call", fromSymbol: "main" }),
        ref({ name: "push", kind: "method", fromSymbol: "main" }), // arr.push() — NOT the function
      ],
      1,
    );
    const n = store.neighborhood("main", { depth: 2 });
    const names = n.nodes.map((x) => x.name).sort();
    expect(names).toContain("helper");
    // `push` was only ever a *method* call, so it must not be pulled in as the function
    expect(n.edges).toContainEqual({ from: "main", to: "helper" });
    expect(n.edges).not.toContainEqual({ from: "main", to: "push" });
  });

  it("treats ambiguous (library-ish) names as unresolved", () => {
    const symbols: ParsedSymbol[] = [];
    for (let i = 0; i < 6; i++) symbols.push(sym({ name: "map", kind: "function" }));
    symbols.push(sym({ name: "caller", kind: "function" }));
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      symbols,
      [ref({ name: "map", kind: "call", fromSymbol: "caller" })],
      1,
    );
    // 6 definitions of `map` exceeds the ambiguity cap (4) → not expanded
    const n = store.neighborhood("caller", { depth: 2, ambiguityCap: 4 });
    expect(n.edges).not.toContainEqual({ from: "caller", to: "map" });
  });

  it("finds callees, impact (blast radius), and task context", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [
        sym({ name: "top", kind: "function" }),
        sym({ name: "main", kind: "function" }),
        sym({ name: "helper", kind: "function" }),
        sym({ name: "leaf", kind: "function" }),
      ],
      [
        ref({ name: "main", kind: "call", fromSymbol: "top" }),
        ref({ name: "helper", kind: "call", fromSymbol: "main" }),
        ref({ name: "leaf", kind: "call", fromSymbol: "helper" }),
      ],
      1,
    );

    // callees: what does main call?
    expect(store.findCallees("main").map((s) => s.name)).toEqual(["helper"]);

    // impact: who is (transitively) affected by changing leaf?
    const impacted = store.impact("leaf", { depth: 3 });
    const byName = new Map(impacted.map((r) => [r.name, r.distance]));
    expect(byName.get("helper")).toBe(1);
    expect(byName.get("main")).toBe(2);
    expect(byName.get("top")).toBe(3);

    // context: a query surfaces the matching symbol plus its neighbourhood
    const ctx = store.context("helper", { maxSymbols: 10 });
    expect(ctx.seeds.map((s) => s.name)).toContain("helper");
    const all = [...ctx.seeds, ...ctx.related].map((s) => s.name);
    expect(all).toEqual(expect.arrayContaining(["helper", "main", "leaf"]));
  });

  it("replaces a file's data incrementally without touching others", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h1", size: 1, mtime: 0 },
      [sym({ name: "alpha", kind: "function" })],
      [],
      1,
    );
    store.replaceFile(
      { path: "b.ts", lang: "typescript", hash: "h2", size: 1, mtime: 0 },
      [sym({ name: "beta", kind: "function" })],
      [],
      1,
    );
    // re-index a.ts with new content
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h3", size: 1, mtime: 0 },
      [sym({ name: "gamma", kind: "function" })],
      [],
      2,
    );
    expect(store.getSymbol("alpha")).toHaveLength(0); // old symbol gone
    expect(store.getSymbol("gamma")).toHaveLength(1); // new symbol present
    expect(store.getSymbol("beta")).toHaveLength(1); // untouched file unaffected
    expect(store.getFileHash("a.ts")).toBe("h3");
  });

  it("cascade-deletes symbols and refs when a file is removed", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [sym({ name: "alpha", kind: "function" })],
      [ref({ name: "x", kind: "call", fromSymbol: "alpha" })],
      1,
    );
    expect(store.removeFile("a.ts")).toBe(true);
    expect(store.getSymbol("alpha")).toHaveLength(0);
    expect(store.findReferences("x")).toHaveLength(0);
    expect(store.stats().refs).toBe(0);
    expect(store.removeFile("a.ts")).toBe(false); // already gone
  });

  it("finds callers across every file that calls a symbol (recall)", () => {
    // The accuracy win rests on this: callers are found in ALL files that call
    // the name, never missing one.
    store.replaceFile(
      { path: "src/util.ts", lang: "typescript", hash: "h1", size: 1, mtime: 0 },
      [sym({ name: "doThing", kind: "function" })],
      [],
      1,
    );
    for (const f of ["a", "b", "c"]) {
      store.replaceFile(
        { path: `src/${f}.ts`, lang: "typescript", hash: f, size: 1, mtime: 0 },
        [sym({ name: `use_${f}`, kind: "function" })],
        [ref({ name: "doThing", kind: "call", fromSymbol: `use_${f}` })],
        1,
      );
    }
    const callerFiles = new Set(store.findCallers("doThing").map((r) => r.file));
    expect(callerFiles).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
  });

  it("does substring search via the trigram FTS index (3+ chars)", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [
        sym({ name: "loadConfiguration", kind: "function" }),
        sym({ name: "ConfigStore", kind: "class" }),
        sym({ name: "unrelated", kind: "function" }),
      ],
      [],
      1,
    );
    // "onfig" is an interior substring — only trigram FTS finds it, and it is case-insensitive
    const names = store.searchSymbols("onfig").map((h) => h.name).sort();
    expect(names).toEqual(["ConfigStore", "loadConfiguration"]);
  });

  it("keeps the FTS index in sync across replace and remove", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h1", size: 1, mtime: 0 },
      [sym({ name: "alphaWidget", kind: "function" })],
      [],
      1,
    );
    expect(store.searchSymbols("widget")).toHaveLength(1);

    // replace the file: old FTS row must be gone, new one present
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h2", size: 1, mtime: 0 },
      [sym({ name: "betaGadget", kind: "function" })],
      [],
      2,
    );
    expect(store.searchSymbols("widget")).toHaveLength(0); // no stale FTS entry
    expect(store.searchSymbols("gadget")).toHaveLength(1);

    // remove the file: FTS row must be gone too
    store.removeFile("a.ts");
    expect(store.searchSymbols("gadget")).toHaveLength(0);
  });

  it("reports aggregate stats", () => {
    store.replaceFile(
      { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
      [sym({ name: "f", kind: "function" }), sym({ name: "C", kind: "class" })],
      [ref({ name: "g", kind: "call", fromSymbol: "f" })],
      1,
    );
    const s = store.stats();
    expect(s.files).toBe(1);
    expect(s.symbols).toBe(2);
    expect(s.refs).toBe(1);
    expect(s.byKind).toMatchObject({ function: 1, class: 1 });
    expect(s.byLang).toMatchObject({ typescript: 1 });
  });
});
