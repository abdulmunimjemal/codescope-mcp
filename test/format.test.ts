import { describe, expect, it } from "vitest";
import {
  formatNeighborhood,
  formatRefs,
  formatStats,
  formatSymbols,
} from "../src/format.js";
import type { Neighborhood, RefRow, SymbolRow } from "../src/types.js";

function symRow(p: Partial<SymbolRow> & { name: string; kind: SymbolRow["kind"] }): SymbolRow {
  return {
    id: 1,
    file: "a.ts",
    container: null,
    exported: false,
    signature: null,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    ...p,
  };
}

describe("format", () => {
  it("renders symbols with 1-based lines, container, and export marker", () => {
    const out = formatSymbols([
      symRow({ name: "run", kind: "method", container: "Service", exported: true, startRow: 9, signature: "run()" }),
    ]);
    expect(out).toBe("method export Service.run — a.ts:10  ·  run()");
  });

  it("has a friendly empty state", () => {
    expect(formatSymbols([])).toMatch(/No matching symbols/);
    expect(formatRefs([])).toMatch(/No references/);
  });

  it("renders references", () => {
    const refs: RefRow[] = [
      { id: 1, file: "a.ts", fromSymbol: "main", name: "helper", kind: "call", startRow: 4, startCol: 2 },
    ];
    expect(formatRefs(refs)).toBe("main → helper [call] — a.ts:5");
  });

  it("renders a neighbourhood with definitions and edges", () => {
    const n: Neighborhood = {
      root: "main",
      nodes: [symRow({ name: "main", kind: "function" }), symRow({ name: "helper", kind: "function" })],
      edges: [{ from: "main", to: "helper" }],
      unresolved: ["external"],
    };
    const out = formatNeighborhood(n);
    expect(out).toContain("neighbourhood of main");
    expect(out).toContain("main → helper");
    expect(out).toContain("unresolved");
  });

  it("renders stats", () => {
    const out = formatStats({
      files: 3,
      symbols: 5,
      refs: 7,
      byKind: { function: 4, class: 1 },
      byLang: { typescript: 3 },
    });
    expect(out).toContain("files:   3");
    expect(out).toContain("function=4");
    expect(out).toContain("typescript=3");
  });
});
