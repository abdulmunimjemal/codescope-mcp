import type {
  ContextBundle,
  ImpactRow,
  IndexStats,
  Neighborhood,
  RefRow,
  SymbolRow,
} from "./types.js";

/**
 * Compact, line-oriented renderers. The whole point of codescope is to hand an
 * agent the *answer* in as few tokens as possible, so these favour terse,
 * grep-like lines over verbose prose or JSON.
 */

/** Keep signatures short — agents pay per token; full detail is one query away. */
function shortSig(sig: string | null): string {
  if (!sig) return "";
  const s = sig.length > 88 ? `${sig.slice(0, 87)}…` : sig;
  return `  ·  ${s}`;
}

function symbolLine(s: SymbolRow): string {
  const loc = `${s.file}:${s.startRow + 1}`;
  const container = s.container ? `${s.container}.` : "";
  const exp = s.exported ? "export " : "";
  return `${s.kind} ${exp}${container}${s.name} — ${loc}${shortSig(s.signature)}`;
}

export function formatSymbols(rows: SymbolRow[]): string {
  if (rows.length === 0) return "No matching symbols.";
  return rows.map(symbolLine).join("\n");
}

export function formatRefs(rows: RefRow[]): string {
  if (rows.length === 0) return "No references.";
  // The referenced name is the query itself, so don't repeat it on every line.
  return rows
    .map((r) => {
      const where = r.fromSymbol ?? "(top level)";
      return `${r.file}:${r.startRow + 1}  ${where}`;
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

export function formatImpact(rows: ImpactRow[]): string {
  if (rows.length === 0) return "No callers — changing this is low-risk.";
  return rows.map((r) => `[${r.distance} hop] ${symbolLine(r)}`).join("\n");
}

export function formatContext(b: ContextBundle): string {
  const lines: string[] = [`context for "${b.query}":`, "", "matches:"];
  if (b.seeds.length === 0) lines.push("  (no symbols matched)");
  else for (const s of b.seeds) lines.push(`  ${symbolLine(s)}`);
  if (b.related.length > 0) {
    lines.push("", "related (ranked by call-site centrality):");
    for (const s of b.related) lines.push(`  ${symbolLine(s)}`);
  }
  if (b.edges.length > 0) {
    lines.push("", "call edges:");
    for (const e of b.edges) lines.push(`  ${e.from} → ${e.to}`);
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
