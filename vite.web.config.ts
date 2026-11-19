/**
 * Frontend asset build (#853, doc/design/serve-api-first-frontend.md): compiles the Svelte
 * components in src/web into a fixed set of same-origin JS/CSS files in dist/web, which the
 * package ships and `pdb serve` reads at startup. Build-time only: no dev server, no SSR, no
 * runtime compiler; CSS is emitted as a file so the strict CSP needs no inline styles.
 */
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [svelte({ compilerOptions: { css: "external" } })],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: { rules: "src/web/rules/main.ts" },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
