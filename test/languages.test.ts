import { describe, expect, it } from "vitest";
import { SUPPORTED_EXTENSIONS, languageForPath } from "../src/languages.js";
import { parseSource } from "../src/parser.js";
import type { ParsedRef, ParsedSymbol } from "../src/types.js";

interface Case {
  lang: string;
  ext: string;
  source: string;
  expectSymbols: Array<[string, ParsedSymbol["kind"]]>;
  expectCalls?: Array<[string, ParsedRef["kind"]]>;
  expectImports?: string[];
}

const CASES: Case[] = [
  {
    lang: "go",
    ext: ".go",
    source: `package main
import "fmt"
type Shape struct{ x int }
func (s Shape) Area() int { return helper(s.x) }
func main() { fmt.Println(Area()) }`,
    expectSymbols: [
      ["Shape", "class"],
      ["Area", "method"],
      ["main", "function"],
    ],
    expectCalls: [
      ["helper", "call"],
      ["Println", "method"],
    ],
    expectImports: ["fmt"],
  },
  {
    lang: "rust",
    ext: ".rs",
    source: `use std::collections::HashMap;
struct Point { x: i32 }
fn main() { let p = compute(); p.dist(); }`,
    expectSymbols: [
      ["Point", "class"],
      ["main", "function"],
    ],
    expectCalls: [
      ["compute", "call"],
      ["dist", "method"],
    ],
    expectImports: ["std::collections::HashMap"],
  },
  {
    lang: "java",
    ext: ".java",
    source: `package app;
import java.util.List;
class Service { int run() { return load(); } private int load(){ return obj.fetch(); } }
interface Repo { void save(); }`,
    expectSymbols: [
      ["Service", "class"],
      ["run", "method"],
      ["Repo", "interface"],
    ],
    expectCalls: [
      ["load", "call"],
      ["fetch", "method"],
    ],
    expectImports: ["java.util.List"],
  },
  {
    lang: "ruby",
    ext: ".rb",
    source: `class Service
  def run
    helper(1)
  end
end`,
    expectSymbols: [
      ["Service", "class"],
      ["run", "method"],
    ],
    expectCalls: [["helper", "call"]],
  },
  {
    lang: "c",
    ext: ".c",
    source: `#include <stdio.h>
int helper(int a) { return a; }
int main() { return helper(compute()); }`,
    expectSymbols: [
      ["helper", "function"],
      ["main", "function"],
    ],
    expectCalls: [
      ["helper", "call"],
      ["compute", "call"],
    ],
    expectImports: ["stdio.h"],
  },
  {
    lang: "cpp",
    ext: ".cpp",
    source: `#include <vector>
class Point { public: int dist() { return helper(x); } };
int main() { Point p; p.dist(); }`,
    expectSymbols: [
      ["Point", "class"],
      ["dist", "method"],
      ["main", "function"],
    ],
    expectCalls: [
      ["helper", "call"],
      ["dist", "method"],
    ],
    expectImports: ["vector"],
  },
  {
    lang: "csharp",
    ext: ".cs",
    source: `using System;
namespace App { class Service { int Run() { return Load(); } int Load(){ return obj.Fetch(); } } }`,
    expectSymbols: [
      ["Service", "class"],
      ["Run", "method"],
      ["Load", "method"],
    ],
    expectCalls: [
      ["Load", "call"],
      ["Fetch", "method"],
    ],
    expectImports: ["System"],
  },
  {
    lang: "php",
    ext: ".php",
    source: `<?php
namespace App;
use Other\\Thing;
class Service { function run() { return helper($this->load()); } }
function top() { return obj_call(); }`,
    expectSymbols: [
      ["Service", "class"],
      ["run", "method"],
      ["top", "function"],
    ],
    expectCalls: [
      ["helper", "call"],
      ["load", "method"],
      ["obj_call", "call"],
    ],
    expectImports: ["Other\\Thing"],
  },
];

describe("language coverage", () => {
  for (const c of CASES) {
    describe(c.lang, () => {
      it("maps its file extension", () => {
        expect(languageForPath(`file${c.ext}`)?.id).toBe(c.lang);
        expect(SUPPORTED_EXTENSIONS).toContain(c.ext);
      });

      it("extracts the expected definitions", async () => {
        const { symbols } = await parseSource(c.lang, c.source);
        for (const [name, kind] of c.expectSymbols) {
          const found = symbols.find((s) => s.name === name && s.kind === kind);
          expect(found, `${c.lang}: expected ${kind} ${name}`).toBeDefined();
        }
      });

      if (c.expectCalls) {
        it("extracts the expected calls", async () => {
          const { refs } = await parseSource(c.lang, c.source);
          for (const [name, kind] of c.expectCalls ?? []) {
            const found = refs.find((r) => r.name === name && r.kind === kind);
            expect(found, `${c.lang}: expected ${kind} ref ${name}`).toBeDefined();
          }
        });
      }

      if (c.expectImports) {
        it("extracts the expected imports", async () => {
          const { refs } = await parseSource(c.lang, c.source);
          const imports = refs.filter((r) => r.kind === "import").map((r) => r.name);
          for (const want of c.expectImports ?? []) {
            expect(imports, `${c.lang}: expected import ${want}`).toContain(want);
          }
        });
      }
    });
  }
});
