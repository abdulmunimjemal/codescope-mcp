import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { GraphStore } from "../src/store.js";
import type { ParsedSymbol } from "../src/types.js";

function sym(name: string, kind: ParsedSymbol["kind"], extra: Partial<ParsedSymbol> = {}): ParsedSymbol {
  return {
    name,
    kind,
    container: null,
    exported: false,
    signature: null,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    startByte: 0,
    endByte: 0,
    ...extra,
  };
}

let store: GraphStore;
let client: Client;

beforeEach(async () => {
  store = new GraphStore(":memory:");
  store.replaceFile(
    { path: "a.ts", lang: "typescript", hash: "h", size: 1, mtime: 0 },
    [
      sym("loadConfig", "function", { exported: true, signature: "function loadConfig()" }),
      sym("Config", "interface"),
      sym("main", "function"),
    ],
    [{ name: "loadConfig", kind: "call", fromSymbol: "main", startRow: 3, startCol: 2 }],
    1,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(store);
  await server.connect(serverTransport);
  client = new Client({ name: "codescope-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  store.close();
});

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("MCP server", () => {
  it("advertises the codescope tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "context",
      "file_outline",
      "find_callees",
      "find_callers",
      "find_references",
      "get_symbol",
      "impact",
      "neighborhood",
      "search_symbols",
      "stats",
    ]);
  });

  it("answers search_symbols", async () => {
    const res = await client.callTool({ name: "search_symbols", arguments: { query: "config" } });
    const text = textOf(res as never);
    expect(text).toContain("loadConfig");
    expect(text).toContain("a.ts:1");
  });

  it("answers find_callers", async () => {
    const res = await client.callTool({ name: "find_callers", arguments: { name: "loadConfig" } });
    expect(textOf(res as never)).toContain("main"); // the caller, located at a.ts:4
  });

  it("answers context", async () => {
    const res = await client.callTool({ name: "context", arguments: { query: "config" } });
    expect(textOf(res as never)).toContain("loadConfig");
  });

  it("answers stats", async () => {
    const res = await client.callTool({ name: "stats", arguments: {} });
    expect(textOf(res as never)).toContain("symbols: 3");
  });

  it("validates input and rejects bad arguments", async () => {
    const res = (await client.callTool({ name: "search_symbols", arguments: {} })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });
});
