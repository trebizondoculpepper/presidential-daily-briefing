/**
 * Build every served frontend page (#853, #684): one Vite+ build per page with
 * vite.web.config.ts, so each page's bundle is self-contained (no shared chunk) and loads as a
 * classic same-origin script under the strict CSP. Writes a fixed set of files in dist/web.
 */
import { spawnSync } from "node:child_process";

const pages = ["rules", "pipeline"];
pages.forEach((page, i) => {
  const result = spawnSync(
    "npx",
    ["vp", "build", "--config", "vite.web.config.ts", "--logLevel", "warn"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, PDB_WEB_ENTRY: page, PDB_WEB_EMPTY: i === 0 ? "1" : "0" },
    },
  );
  if (result.status !== 0) {
    console.error(`Frontend build failed for ${page}.`);
    process.exit(result.status ?? 1);
  }
});
