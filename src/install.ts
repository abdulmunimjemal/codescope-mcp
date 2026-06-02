import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The npm package name and the MCP server key codescope registers under. */
export const PACKAGE = "codescope-mcp";
export const MCP_SERVER_NAME = "codescope";

/** Agents whose config is plain JSON with an `mcpServers` map (auto-wirable). */
export type AgentId = "claude" | "cursor";
export const SUPPORTED_AGENTS: readonly AgentId[] = ["claude", "cursor"];

export interface ServerEntry {
  command: string;
  args: string[];
}

/** The MCP server entry agents need to launch codescope over stdio. */
export function serverEntry(serveTarget = "."): ServerEntry {
  return { command: "npx", args: ["-y", PACKAGE, "mcp", serveTarget] };
}

/** The config file codescope writes for a given agent. */
export function configPath(agent: AgentId, root: string, global = false): string {
  switch (agent) {
    case "claude":
      return global ? join(homedir(), ".mcp.json") : join(root, ".mcp.json");
    case "cursor":
      return global ? join(homedir(), ".cursor", "mcp.json") : join(root, ".cursor", "mcp.json");
  }
}

export interface InstallOutcome {
  agent: AgentId;
  path: string;
  action: "added" | "updated";
}

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

/**
 * Idempotently wire codescope into an agent's MCP config. Preserves any other
 * servers already configured and overwrites only the `codescope` entry.
 */
export function installInto(
  agent: AgentId,
  root: string,
  opts: { global?: boolean; serveTarget?: string } = {},
): InstallOutcome {
  const path = configPath(agent, root, opts.global ?? false);
  const config = readJson(path);

  const existing = config.mcpServers;
  const servers: JsonObject =
    existing && typeof existing === "object" ? (existing as JsonObject) : {};
  const existed = Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME);
  servers[MCP_SERVER_NAME] = serverEntry(opts.serveTarget);
  config.mcpServers = servers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { agent, path, action: existed ? "updated" : "added" };
}

/** Wire codescope into one or more agents. */
export function install(
  root: string,
  opts: { agents?: AgentId[]; global?: boolean; serveTarget?: string } = {},
): InstallOutcome[] {
  const agents = opts.agents ?? [...SUPPORTED_AGENTS];
  return agents.map((agent) => installInto(agent, root, opts));
}

/** Copy-paste config for agents whose config isn't plain JSON (e.g. Codex, TOML). */
export function codexSnippet(serveTarget = "."): string {
  return [
    "[mcp_servers.codescope]",
    'command = "npx"',
    `args = ["-y", "${PACKAGE}", "mcp", "${serveTarget}"]`,
  ].join("\n");
}
