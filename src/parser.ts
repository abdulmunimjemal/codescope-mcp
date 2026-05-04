import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import {
  LANGUAGES,
  type CallRule,
  type DefRule,
  type ImportRule,
  type LanguageConfig,
} from "./languages.js";
import type { ParsedRef, ParsedSymbol, ParseResult, SymbolKind } from "./types.js";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const parserCache = new Map<string, Parser>();

/** Resolve a grammar wasm shipped by `tree-sitter-wasms`. */
function grammarPath(wasm: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${wasm}.wasm`);
}

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

/** Lazily load (and cache) a configured parser for a language. */
async function getParser(lang: LanguageConfig): Promise<Parser> {
  const cached = parserCache.get(lang.id);
  if (cached) return cached;
  await ensureInit();
  const language = await Parser.Language.load(grammarPath(lang.wasm));
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang.id, parser);
  return parser;
}

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

/** Parse a source string into symbols and references. */
export async function parseSource(langId: string, source: string): Promise<ParseResult> {
  const lang = LANGUAGES[langId];
  if (!lang) throw new Error(`Unknown language: ${langId}`);
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  const symbols: ParsedSymbol[] = [];
  const refs: ParsedRef[] = [];
  if (tree?.rootNode) {
    walk(tree.rootNode, lang, null, null, symbols, refs);
    tree.delete();
  }
  return { lang: lang.id, symbols, refs };
}

function walk(
  node: Parser.SyntaxNode,
  lang: LanguageConfig,
  container: string | null,
  containerKind: SymbolKind | null,
  symbols: ParsedSymbol[],
  refs: ParsedRef[],
): void {
  let childContainer = container;
  let childContainerKind = containerKind;

  const rule = classify(node, lang);
  const call = lang.callRules.find((r) => r.type === node.type);
  const imp = lang.importRules.find((r) => r.type === node.type);

  if (rule) {
    const sym = buildSymbol(node, rule, container, containerKind, lang);
    if (sym) {
      symbols.push(sym);
      childContainer = sym.name;
      childContainerKind = sym.kind;
    }
  } else if (call) {
    const ref = extractCall(node, call, container);
    if (ref) refs.push(ref);
  } else if (imp) {
    for (const ref of extractImports(node, imp, container)) refs.push(ref);
  }

  for (const child of node.namedChildren) {
    walk(child, lang, childContainer, childContainerKind, symbols, refs);
  }
}

function classify(node: Parser.SyntaxNode, lang: LanguageConfig): DefRule | null {
  const direct = lang.defs[node.type];
  if (direct) return direct;
  if (lang.functionBindings.has(node.type)) {
    const value = node.childForFieldName("value");
    if (value && FUNCTION_VALUE_TYPES.has(value.type)) return { kind: "function" };
  }
  return null;
}

function buildSymbol(
  node: Parser.SyntaxNode,
  rule: DefRule,
  container: string | null,
  containerKind: SymbolKind | null,
  lang: LanguageConfig,
): ParsedSymbol | null {
  const name = symbolName(node, rule.name ?? "field");
  if (!name) return null;
  let kind = rule.kind;
  if (kind === "function" && lang.nestedFunctionsAreMethods && containerKind === "class") {
    kind = "method";
  }
  return {
    name,
    kind,
    container,
    exported: isExported(node, lang),
    signature: signatureOf(node),
    startRow: node.startPosition.row,
    startCol: node.startPosition.column,
    endRow: node.endPosition.row,
    endCol: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

function symbolName(node: Parser.SyntaxNode, strategy: DefRule["name"]): string | null {
  if (strategy === "c_declarator") return cDeclaratorName(node);
  return node.childForFieldName("name")?.text ?? null;
}

/** Dig through C/C++ declarator chains (`int *foo(...)`) to the actual name. */
function cDeclaratorName(node: Parser.SyntaxNode): string | null {
  let decl = node.childForFieldName("declarator");
  for (let i = 0; decl && i < 10; i++) {
    if (decl.type === "identifier" || decl.type === "field_identifier") return decl.text;
    if (decl.type === "qualified_identifier" || decl.type === "destructor_name") {
      return decl.childForFieldName("name")?.text ?? decl.text;
    }
    const inner = decl.childForFieldName("declarator");
    if (!inner) break;
    decl = inner;
  }
  return null;
}

/** A definition is exported if an `export` statement directly wraps it. */
function isExported(node: Parser.SyntaxNode, lang: LanguageConfig): boolean {
  if (lang.exportTypes.size === 0) return false;
  let cur = node.parent;
  for (let i = 0; cur && i < 2; i++) {
    if (lang.exportTypes.has(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

/** The declaration text up to (but not including) the body, on one line. */
function signatureOf(node: Parser.SyntaxNode): string | null {
  const body = node.childForFieldName("body");
  const raw = body
    ? node.text.slice(0, body.startIndex - node.startIndex)
    : node.text;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function extractCall(
  node: Parser.SyntaxNode,
  rule: CallRule,
  container: string | null,
): ParsedRef | null {
  let name: string | null = null;
  let kind: "call" | "method" = "call";

  if (rule.nameField) {
    // The call node carries the callee name directly (Java/Ruby/PHP member).
    name = node.childForFieldName(rule.nameField)?.text ?? null;
    if (rule.receiverField && node.childForFieldName(rule.receiverField)) kind = "method";
  } else if (rule.fnField) {
    const fn = node.childForFieldName(rule.fnField);
    if (fn) {
      if (rule.memberTypes?.includes(fn.type)) {
        name = fn.childForFieldName(rule.memberField ?? "")?.text ?? null;
        kind = "method";
      } else if (rule.scopedTypes?.includes(fn.type)) {
        name = fn.childForFieldName(rule.scopedField ?? "")?.text ?? null;
      } else if (fn.type === "identifier" || fn.type === "name") {
        name = fn.text;
      }
    }
  }

  if (rule.forceKind) kind = rule.forceKind;
  if (!name) return null;
  return {
    fromSymbol: container,
    name,
    kind,
    startRow: node.startPosition.row,
    startCol: node.startPosition.column,
  };
}

function extractImports(
  node: Parser.SyntaxNode,
  rule: ImportRule,
  container: string | null,
): ParsedRef[] {
  const out: ParsedRef[] = [];
  const add = (spec: string | null | undefined): void => {
    const name = spec ? unquote(spec) : "";
    if (name) {
      out.push({
        fromSymbol: container,
        name,
        kind: "import",
        startRow: node.startPosition.row,
        startCol: node.startPosition.column,
      });
    }
  };

  if (rule.field) {
    add(node.childForFieldName(rule.field)?.text);
  }
  if (rule.childTypes) {
    for (const child of node.namedChildren) {
      if (!rule.childTypes.includes(child.type)) continue;
      // python `import x as y` exposes the real module under the `name` field
      if (child.type === "aliased_import") add(child.childForFieldName("name")?.text);
      else add(child.text);
    }
  }
  return out;
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      return t.slice(1, -1);
    }
    // C/C++ include targets: <stdio.h>
    if (first === "<" && last === ">") return t.slice(1, -1);
  }
  return t;
}

/** Test helper: drop cached parsers so a fresh init can be exercised. */
export function _resetParsers(): void {
  parserCache.clear();
  initPromise = null;
}
