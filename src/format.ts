import type { IndexStats, Neighborhood, RefRow, SymbolRow } from "./types.js";

/**
 * Compact, line-oriented renderers. The whole point of codescope is to hand an
 * agent the *answer* in as few tokens as possible, so these favour terse,
 * grep-like lines over verbose prose or JSON.
 */

function symbolLine(s: SymbolRow): string {
  const loc = `${s.file}:${s.startRow + 1}`;
  const container = s.container ? `${s.container}.` : "";
  const exp = s.exported ? "export " : "";
  const sig = s.signature ? `  ·  ${s.signature}` : "";
  return `${s.kind} ${exp}${container}${s.name} — ${loc}${sig}`;
}

export function formatSymbols(rows: SymbolRow[]): string {
  if (rows.length === 0) return "No matching symbols.";
  return rows.map(symbolLine).join("\n");
}

export function formatRefs(rows: RefRow[]): string {
  if (rows.length === 0) return "No references.";
  return rows
    .map((r) => {
      const where = r.fromSymbol ? `${r.fromSymbol}` : "(top level)";
      return `${where} → ${r.name} [${r.kind}] — ${r.file}:${r.startRow + 1}`;
    })
    .join("\n");
}

export function formatNeighborhood(n: Neighborhood): string {
  const lines: string[] = [`neighbourhood of ${n.root}:`];
  lines.push("", "definitions:");
  if (n.nodes.length === 0) lines.push("  (none indexed)");
  else for (const s of n.nodes) lines.push(`  ${symbolLine(s)}`);
  if (n.edges.length > 0) {
    lines.push("", "call edges:");
    for (const e of n.edges) lines.push(`  ${e.from} → ${e.to}`);
  }
  if (n.unresolved.length > 0) {
    lines.push("", `unresolved (referenced, not defined in index): ${n.unresolved.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatStats(s: IndexStats): string {
  const kinds = Object.entries(s.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  const langs = Object.entries(s.byLang)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  return [
    `files:   ${s.files}`,
    `symbols: ${s.symbols}  (${kinds || "none"})`,
    `refs:    ${s.refs}`,
    `langs:   ${langs || "none"}`,
  ].join("\n");
}
