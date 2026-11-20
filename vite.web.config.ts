/**
 * Frontend asset build (#853, doc/design/serve-api-first-frontend.md): compiles the Svelte
 * components in src/web into a fixed set of same-origin JS/CSS files in dist/web, which the
 * package ships and `pdb serve` reads at startup. Build-time only: no dev server, no SSR, no
 * runtime compiler; CSS is emitted as a file so the strict CSP needs no inline styles.
 */
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite-plus";

/**
 * One page per build (scripts/build-web.ts sets PDB_WEB_ENTRY): each page's bundle is then
 * self-contained, with no shared chunk to import, so classic same-origin scripts load it.
 */
const entries = {
  rules: "src/web/rules/main.ts",
  pipeline: "src/web/pipeline/main.ts",
  work: "src/web/work/main.ts",
  timing: "src/web/timing/main.ts",
  discussion: "src/web/discussion/main.ts",
} as const;
const entry = (process.env.PDB_WEB_ENTRY ?? "rules") as keyof typeof entries;
if (!(entry in entries)) throw new Error(`Unknown PDB_WEB_ENTRY ${entry}.`);

export default defineConfig({
  plugins: [svelte({ compilerOptions: { css: "external" } })],
  build: {
    outDir: "dist/web",
    // The first page's build clears dist/web; later pages add to it.
    emptyOutDir: process.env.PDB_WEB_EMPTY !== "0",
    sourcemap: false,
    // CSS as a file, never injected by script: the strict CSP allows no inline styles.
    cssCodeSplit: false,
    rollupOptions: {
      input: { [entry]: entries[entry] },
      output: {
        // A classic script with its own scope: no globals leak beside the shell's scripts.
        format: "iife",
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        // The single stylesheet is named after its page (rules.css, pipeline.css).
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith(".css")) ? `${entry}.css` : "[name][extname]",
      },
    },
  },
});
