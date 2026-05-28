import type { SymbolKind } from "./types.js";

/**
 * Per-language configuration driving the AST walk in {@link ./parser.ts}.
 *
 * Rather than maintain a tree-sitter query (`.scm`) per grammar, we walk the
 * tree once and classify nodes by `type` using these tables. Grammars disagree
 * on a lot — C buries a function's name inside nested declarators, Java and Ruby
 * hang the callee straight off the call node, Go/Rust/C++ each use a different
 * "member access" node — so definitions, calls, and imports are all described
 * declaratively here and interpreted by a single generic walker.
 */

export type NameStrategy = "field" | "c_declarator" | "first_typed";

export interface DefRule {
  kind: SymbolKind;
  /** How to read the definition's name (default: `field` on `name`). */
  name?: NameStrategy;
  /** For the `field` strategy: which field holds the name (default `name`). */
  nameField?: string;
  /** For the `first_typed` strategy: pick the first named child of these types. */
  nameTypes?: string[];
}

export interface CallRule {
  /** AST node type for this kind of call. */
  type: string;
  /** Field holding the callee expression (for `foo()` / `a.foo()` forms). */
  fnField?: string;
  /** Callee-expression node types that mean "method call". */
  memberTypes?: string[];
  /** Field on a member node holding the method name. */
  memberField?: string;
  /** Callee-expression node types that are path-qualified (`a::b`). */
  scopedTypes?: string[];
  /** Field on a scoped node holding the final name. */
  scopedField?: string;
  /** The call node holds the callee name directly in this field (Java/Ruby). */
  nameField?: string;
  /** Presence of this field on the call node marks it a method call. */
  receiverField?: string;
  /** Force the ref kind regardless of shape. */
  forceKind?: "call" | "method";
}

export interface ImportRule {
  type: string;
  /** Read the import target from this field's text. */
  field?: string;
  /** Collect import targets from named children of these types. */
  childTypes?: string[];
}

export interface LanguageConfig {
  id: string;
  wasm: string;
  defs: Record<string, DefRule>;
  /** Bindings (`const x = …`) that become `function` symbols when assigned a function. */
  functionBindings: Set<string>;
  /** A nested `function` whose enclosing definition is a class becomes a `method`. */
  nestedFunctionsAreMethods: boolean;
  callRules: CallRule[];
  importRules: ImportRule[];
  /** Node types whose presence as an ancestor marks a definition as exported. */
  exportTypes: Set<string>;
}

const JS_CALLS: CallRule[] = [
  { type: "call_expression", fnField: "function", memberTypes: ["member_expression"], memberField: "property" },
];

const typescript: LanguageConfig = {
  id: "typescript",
  wasm: "typescript",
  defs: {
    function_declaration: { kind: "function" },
    generator_function_declaration: { kind: "function" },
    function_signature: { kind: "function" },
    method_definition: { kind: "method" },
    method_signature: { kind: "method" },
    class_declaration: { kind: "class" },
    abstract_class_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    type_alias_declaration: { kind: "type" },
    enum_declaration: { kind: "enum" },
  },
  functionBindings: new Set(["variable_declarator", "public_field_definition"]),
  nestedFunctionsAreMethods: false,
  callRules: JS_CALLS,
  importRules: [{ type: "import_statement", field: "source" }],
  exportTypes: new Set(["export_statement"]),
};

const tsx: LanguageConfig = { ...typescript, id: "tsx", wasm: "tsx" };

const javascript: LanguageConfig = {
  id: "javascript",
  wasm: "javascript",
  defs: {
    function_declaration: { kind: "function" },
    generator_function_declaration: { kind: "function" },
    method_definition: { kind: "method" },
    class_declaration: { kind: "class" },
  },
  functionBindings: new Set(["variable_declarator", "field_definition"]),
  nestedFunctionsAreMethods: false,
  callRules: JS_CALLS,
  importRules: [{ type: "import_statement", field: "source" }],
  exportTypes: new Set(["export_statement"]),
};

const python: LanguageConfig = {
  id: "python",
  wasm: "python",
  defs: {
    function_definition: { kind: "function" },
    class_definition: { kind: "class" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "call", fnField: "function", memberTypes: ["attribute"], memberField: "attribute" }],
  importRules: [
    { type: "import_statement", childTypes: ["dotted_name", "aliased_import"] },
    { type: "import_from_statement", field: "module_name" },
  ],
  exportTypes: new Set(),
};

const go: LanguageConfig = {
  id: "go",
  wasm: "go",
  defs: {
    function_declaration: { kind: "function" },
    method_declaration: { kind: "method" },
    type_spec: { kind: "class" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    { type: "call_expression", fnField: "function", memberTypes: ["selector_expression"], memberField: "field" },
  ],
  importRules: [{ type: "import_spec", field: "path" }],
  exportTypes: new Set(),
};

const rust: LanguageConfig = {
  id: "rust",
  wasm: "rust",
  defs: {
    function_item: { kind: "function" },
    struct_item: { kind: "class" },
    union_item: { kind: "class" },
    enum_item: { kind: "enum" },
    trait_item: { kind: "interface" },
    type_item: { kind: "type" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    {
      type: "call_expression",
      fnField: "function",
      memberTypes: ["field_expression"],
      memberField: "field",
      scopedTypes: ["scoped_identifier"],
      scopedField: "name",
    },
  ],
  importRules: [{ type: "use_declaration", field: "argument" }],
  exportTypes: new Set(),
};

const java: LanguageConfig = {
  id: "java",
  wasm: "java",
  defs: {
    class_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    enum_declaration: { kind: "enum" },
    record_declaration: { kind: "class" },
    method_declaration: { kind: "method" },
    constructor_declaration: { kind: "method" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "method_invocation", nameField: "name", receiverField: "object" }],
  importRules: [{ type: "import_declaration", childTypes: ["scoped_identifier", "identifier"] }],
  exportTypes: new Set(),
};

const ruby: LanguageConfig = {
  id: "ruby",
  wasm: "ruby",
  defs: {
    method: { kind: "method" },
    singleton_method: { kind: "method" },
    class: { kind: "class" },
    module: { kind: "class" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "call", nameField: "method", receiverField: "receiver" }],
  importRules: [],
  exportTypes: new Set(),
};

const c: LanguageConfig = {
  id: "c",
  wasm: "c",
  defs: {
    function_definition: { kind: "function", name: "c_declarator" },
    struct_specifier: { kind: "class" },
    union_specifier: { kind: "class" },
    enum_specifier: { kind: "enum" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    { type: "call_expression", fnField: "function", memberTypes: ["field_expression"], memberField: "field" },
  ],
  importRules: [{ type: "preproc_include", field: "path" }],
  exportTypes: new Set(),
};

const cpp: LanguageConfig = {
  id: "cpp",
  wasm: "cpp",
  defs: {
    function_definition: { kind: "function", name: "c_declarator" },
    class_specifier: { kind: "class" },
    struct_specifier: { kind: "class" },
    enum_specifier: { kind: "enum" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: true,
  callRules: [
    { type: "call_expression", fnField: "function", memberTypes: ["field_expression"], memberField: "field" },
  ],
  importRules: [{ type: "preproc_include", field: "path" }],
  exportTypes: new Set(),
};

const csharp: LanguageConfig = {
  id: "csharp",
  wasm: "c_sharp",
  defs: {
    class_declaration: { kind: "class" },
    struct_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    enum_declaration: { kind: "enum" },
    record_declaration: { kind: "class" },
    method_declaration: { kind: "method" },
    constructor_declaration: { kind: "method" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    {
      type: "invocation_expression",
      fnField: "function",
      memberTypes: ["member_access_expression"],
      memberField: "name",
    },
  ],
  importRules: [{ type: "using_directive", childTypes: ["identifier", "qualified_name"] }],
  exportTypes: new Set(),
};

const php: LanguageConfig = {
  id: "php",
  wasm: "php",
  defs: {
    function_definition: { kind: "function" },
    method_declaration: { kind: "method" },
    class_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    trait_declaration: { kind: "class" },
    enum_declaration: { kind: "enum" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    { type: "function_call_expression", fnField: "function" },
    { type: "member_call_expression", nameField: "name", forceKind: "method" },
    { type: "scoped_call_expression", nameField: "name", forceKind: "method" },
  ],
  importRules: [{ type: "namespace_use_declaration", childTypes: ["namespace_use_clause"] }],
  exportTypes: new Set(),
};

const scala: LanguageConfig = {
  id: "scala",
  wasm: "scala",
  defs: {
    class_definition: { kind: "class" },
    object_definition: { kind: "class" },
    trait_definition: { kind: "interface" },
    function_definition: { kind: "method" },
    type_definition: { kind: "type" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [
    { type: "call_expression", fnField: "function", memberTypes: ["field_expression"], memberField: "field" },
  ],
  importRules: [{ type: "import_declaration", childTypes: ["stable_identifier", "identifier"] }],
  exportTypes: new Set(),
};

const solidity: LanguageConfig = {
  id: "solidity",
  wasm: "solidity",
  defs: {
    contract_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    library_declaration: { kind: "class" },
    function_definition: { kind: "method" },
    modifier_definition: { kind: "function" },
    struct_declaration: { kind: "class" },
    enum_declaration: { kind: "enum" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "call_expression", fnField: "function" }],
  importRules: [{ type: "import_directive", field: "source" }],
  exportTypes: new Set(),
};

const zig: LanguageConfig = {
  id: "zig",
  wasm: "zig",
  defs: { function_declaration: { kind: "function" } },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "call_expression", fnField: "function" }],
  importRules: [],
  exportTypes: new Set(),
};

const kotlin: LanguageConfig = {
  id: "kotlin",
  wasm: "kotlin",
  defs: {
    class_declaration: { kind: "class", name: "first_typed", nameTypes: ["type_identifier"] },
    object_declaration: { kind: "class", name: "first_typed", nameTypes: ["type_identifier"] },
    function_declaration: { kind: "function", name: "first_typed", nameTypes: ["simple_identifier"] },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: true,
  callRules: [],
  importRules: [{ type: "import_header", childTypes: ["identifier"] }],
  exportTypes: new Set(),
};

const objc: LanguageConfig = {
  id: "objc",
  wasm: "objc",
  defs: {
    class_interface: { kind: "class", name: "first_typed", nameTypes: ["identifier"] },
    class_implementation: { kind: "class", name: "first_typed", nameTypes: ["identifier"] },
    method_declaration: { kind: "method", name: "first_typed", nameTypes: ["identifier"] },
    method_definition: { kind: "method", name: "first_typed", nameTypes: ["identifier"] },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [{ type: "call_expression", fnField: "function" }],
  importRules: [{ type: "preproc_include", field: "path" }],
  exportTypes: new Set(),
};

const lua: LanguageConfig = {
  id: "lua",
  wasm: "lua",
  defs: {
    function_definition_statement: { kind: "function" },
    local_function_definition_statement: { kind: "function" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [],
  importRules: [],
  exportTypes: new Set(),
};

const bash: LanguageConfig = {
  id: "bash",
  wasm: "bash",
  defs: { function_definition: { kind: "function" } },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [],
  importRules: [],
  exportTypes: new Set(),
};

const ocaml: LanguageConfig = {
  id: "ocaml",
  wasm: "ocaml",
  defs: {
    let_binding: { kind: "function", name: "field", nameField: "pattern" },
    module_definition: { kind: "class" },
    type_definition: { kind: "type" },
  },
  functionBindings: new Set(),
  nestedFunctionsAreMethods: false,
  callRules: [],
  importRules: [],
  exportTypes: new Set(),
};

/** All languages codescope can parse, keyed by config id. */
export const LANGUAGES: Record<string, LanguageConfig> = {
  typescript,
  tsx,
  javascript,
  python,
  go,
  rust,
  java,
  ruby,
  c,
  cpp,
  csharp,
  php,
  scala,
  solidity,
  zig,
  kotlin,
  objc,
  lua,
  bash,
  ocaml,
};

/** File extension → language id. */
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".scala": "scala",
  ".sc": "scala",
  ".sol": "solidity",
  ".zig": "zig",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".m": "objc",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".ml": "ocaml",
  ".mli": "ocaml",
};

/** The set of file extensions codescope indexes (with leading dot). */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_LANG);

/** Resolve a language config from a file path, or `undefined` if unsupported. */
export function languageForPath(path: string): LanguageConfig | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = path.slice(dot).toLowerCase();
  const id = EXT_TO_LANG[ext];
  return id ? LANGUAGES[id] : undefined;
}
