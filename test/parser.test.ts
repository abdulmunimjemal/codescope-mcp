import { describe, expect, it } from "vitest";
import { parseSource } from "../src/parser.js";
import type { ParsedSymbol } from "../src/types.js";

function byName(symbols: ParsedSymbol[], name: string): ParsedSymbol | undefined {
  return symbols.find((s) => s.name === name);
}

describe("parseSource — typescript", () => {
  const source = `
import { readFile } from "node:fs/promises";
import helper from "./helper";

export function greet(name: string): string {
  return format(name);
}

const shout = (text: string) => greet(text).toUpperCase();

export class Service {
  run() {
    return this.load();
  }
  private load() {
    return readFile("x");
  }
}

export interface Options { verbose: boolean; }
export type Id = string | number;
export enum Color { Red, Green }
`;

  it("extracts functions, classes, methods, interfaces, types, enums", async () => {
    const { symbols } = await parseSource("typescript", source);
    const kinds = (name: string) => byName(symbols, name)?.kind;
    expect(kinds("greet")).toBe("function");
    expect(kinds("shout")).toBe("function"); // arrow binding
    expect(kinds("Service")).toBe("class");
    expect(kinds("run")).toBe("method");
    expect(kinds("load")).toBe("method");
    expect(kinds("Options")).toBe("interface");
    expect(kinds("Id")).toBe("type");
    expect(kinds("Color")).toBe("enum");
  });

  it("tracks container and export flags", async () => {
    const { symbols } = await parseSource("typescript", source);
    expect(byName(symbols, "run")?.container).toBe("Service");
    expect(byName(symbols, "greet")?.exported).toBe(true);
    expect(byName(symbols, "Service")?.exported).toBe(true);
    // a private method's class is exported, but the method itself is not directly exported
    expect(byName(symbols, "load")?.exported).toBe(false);
  });

  it("captures a one-line signature without the body", async () => {
    const { symbols } = await parseSource("typescript", source);
    const sig = byName(symbols, "greet")?.signature ?? "";
    expect(sig).toContain("function greet(name: string)");
    expect(sig).not.toContain("return");
  });

  it("distinguishes bare calls from method calls and records imports", async () => {
    const { refs } = await parseSource("typescript", source);
    const greetCall = refs.find((r) => r.name === "greet" && r.kind === "call");
    expect(greetCall).toBeDefined();
    expect(greetCall?.fromSymbol).toBe("shout");

    const methodCall = refs.find((r) => r.name === "load" && r.kind === "method");
    expect(methodCall).toBeDefined();
    expect(methodCall?.fromSymbol).toBe("run");

    const imports = refs.filter((r) => r.kind === "import").map((r) => r.name).sort();
    expect(imports).toEqual(["./helper", "node:fs/promises"]);
  });
});

describe("parseSource — javascript", () => {
  it("handles classes, methods, and arrow bindings", async () => {
    const { symbols, refs } = await parseSource(
      "javascript",
      `export class Cart {
         total() { return sum(this.items); }
       }
       const add = (a, b) => a + b;`,
    );
    expect(byName(symbols, "Cart")?.kind).toBe("class");
    expect(byName(symbols, "total")?.kind).toBe("method");
    expect(byName(symbols, "add")?.kind).toBe("function");
    expect(refs.some((r) => r.name === "sum" && r.kind === "call")).toBe(true);
  });
});

describe("parseSource — tsx", () => {
  it("parses a component and its calls", async () => {
    const { symbols, refs } = await parseSource(
      "tsx",
      `export function App() {
         const [n, setN] = useState(0);
         return null;
       }`,
    );
    expect(byName(symbols, "App")?.kind).toBe("function");
    expect(refs.some((r) => r.name === "useState" && r.kind === "call")).toBe(true);
  });
});

describe("parseSource — python", () => {
  const source = `import os
from app.models import User

def greet(name):
    return format_name(name)

class Service:
    def run(self):
        return self.load()
    def load(self):
        return os.getcwd()
`;

  it("extracts functions and classes with containers", async () => {
    const { symbols } = await parseSource("python", source);
    expect(byName(symbols, "greet")?.kind).toBe("function");
    expect(byName(symbols, "Service")?.kind).toBe("class");
    expect(byName(symbols, "run")?.kind).toBe("function"); // python methods are function_definition
    expect(byName(symbols, "run")?.container).toBe("Service");
  });

  it("records calls, method calls, and imports", async () => {
    const { refs } = await parseSource("python", source);
    expect(refs.some((r) => r.name === "format_name" && r.kind === "call")).toBe(true);
    expect(refs.some((r) => r.name === "getcwd" && r.kind === "method")).toBe(true);
    const imports = refs.filter((r) => r.kind === "import").map((r) => r.name).sort();
    expect(imports).toEqual(["app.models", "os"]);
  });
});

describe("parseSource — robustness", () => {
  it("returns empty results for empty input", async () => {
    const { symbols, refs } = await parseSource("typescript", "");
    expect(symbols).toEqual([]);
    expect(refs).toEqual([]);
  });

  it("does not throw on syntactically broken input", async () => {
    const { symbols } = await parseSource("typescript", "function ( { incomplete");
    expect(Array.isArray(symbols)).toBe(true);
  });

  it("throws on an unknown language id", async () => {
    await expect(parseSource("cobol", "x")).rejects.toThrow(/Unknown language/);
  });
});
