import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(
  new URL(".", import.meta.url),
);

export default defineConfig({
  publicDir: false,
  build: {
    target: "esnext",
    outDir: resolve(projectRoot, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(
        projectRoot,
        "src/content/index.ts",
      ),
      output: {
        format: "iife",
        entryFileNames: "content.js",
        inlineDynamicImports: true,
      },
    },
  },

  // pcm-worklet.js is emitted by the main ESM pass.
  // AudioWorklet.addModule() loads module scripts, and the
  // worklet entry has no imports from extension application code.
});
