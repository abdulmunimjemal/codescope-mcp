import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fmt from "./format.js";
import type { GraphStore } from "./store.js";
import { VERSION } from "./version.js";

const KIND = z.enum(["function", "method", "class", "interface", "type", "enum", "variable"]);

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

/**
 * Build the codescope MCP server over an already-populated {@link GraphStore}.
 * Tool descriptions are written *for the agent*: they nudge it to query the
 * graph instead of grepping and reading whole files.
 */
export function createServer(store: GraphStore): McpServer {
  const server = new McpServer({ name: "codescope", version: VERSION });

  server.registerTool(
    "search_symbols",
    {
      title: "Search code symbols",
      description:
        "Fuzzy-search definitions (functions, classes, methods, interfaces, types, enums) by name across the whole repo. Prefer this over grep/glob/read when locating where something is defined — it returns exact file:line locations and signatures in a few tokens.",
      inputSchema: {
        query: z.string().describe("substring to match against symbol names"),
        kind: KIND.optional().describe("restrict to one symbol kind"),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ query, kind, limit }) =>
      textResult(fmt.formatSymbols(store.searchSymbols(query, { kind, limit }))),
  );

  server.registerTool(
    "get_symbol",
    {
      title: "Get a symbol definition",
      description:
        "Look up a definition by its exact name. Returns each matching definition's kind, file:line, and signature. Use this to jump straight to a definition instead of reading files.",
      inputSchema: {
        name: z.string().describe("exact symbol name"),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ name, limit }) => textResult(fmt.formatSymbols(store.getSymbol(name, { limit }))),
  );

  server.registerTool(
    "find_callers",
    {
      title: "Find callers",
      description:
        "List the symbols that call a given function/method name, with file:line. Use this to trace impact and call sites without scanning files.",
      inputSchema: {
        name: z.string().describe("the called function/method name"),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ name, limit }) => textResult(fmt.formatRefs(store.findCallers(name, { limit }))),
  );

  server.registerTool(
    "find_references",
    {
      title: "Find references",
      description:
        "List all references (calls and imports) to a name. Useful for understanding how widely something is used.",
      inputSchema: {
        name: z.string(),
        kind: z.enum(["call", "method", "import"]).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ name, kind, limit }) =>
      textResult(fmt.formatRefs(store.findReferences(name, { kind, limit }))),
  );

  server.registerTool(
    "file_outline",
    {
      title: "Outline a file",
      description:
        "List every symbol defined in a file, in source order, with signatures. A compact alternative to reading the whole file when you only need its shape.",
      inputSchema: {
        path: z.string().describe("repo-relative file path"),
      },
    },
    async ({ path }) => textResult(fmt.formatSymbols(store.fileOutline(path))),
  );

  server.registerTool(
    "neighborhood",
    {
      title: "Call neighbourhood",
      description:
        "Return the call neighbourhood around a symbol — its callers and callees expanded a few hops — as a compact subgraph. This is the high-leverage tool: it gives you the relevant slice of the codebase for a change without reading dozens of files.",
      inputSchema: {
        name: z.string(),
        depth: z.number().int().min(1).max(5).optional().describe("hops to expand (default 2)"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ name, depth, limit }) =>
      textResult(fmt.formatNeighborhood(store.neighborhood(name, { depth, limit }))),
  );

  server.registerTool(
    "stats",
    {
      title: "Graph stats",
      description: "Summary counts for the indexed graph (files, symbols, refs, by kind and language).",
      inputSchema: {},
    },
    async () => textResult(fmt.formatStats(store.stats())),
  );

  return server;
}

/** Connect a codescope server to stdio (the transport coding agents speak). */
export async function runStdioServer(store: GraphStore): Promise<void> {
  const server = createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
