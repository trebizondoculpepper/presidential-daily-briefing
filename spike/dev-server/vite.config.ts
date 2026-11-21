// Experimental (#791): a disposable Vite+ dev server for one Svelte module. Not wired into
// `npm run dev`, the production build or the package; see doc/reports/dev-server-spike.md.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte()],
  server: { host: "127.0.0.1", port: 5199, strictPort: true },
});
