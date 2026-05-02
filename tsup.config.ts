import { defineConfig } from "tsup";

// Library + CLI: ESM, types, dependencies kept external (installed via npm).
// The tree-sitter grammar .wasm files ship with `tree-sitter-wasms` and are
// resolved at runtime, so nothing is bundled or inlined here.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
