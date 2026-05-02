import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // web-tree-sitter has to initialise a wasm runtime on first use, so give
    // the suite a little headroom over the default timeout.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
