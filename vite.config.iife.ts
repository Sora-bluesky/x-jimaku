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

  // The main ESM pass emits the import-free
  // src/offscreen/worklet/pcm-worklet.ts entry as
  // dist/pcm-worklet.js. The manifest exposes that
  // module to the supported web-page origins.
});
