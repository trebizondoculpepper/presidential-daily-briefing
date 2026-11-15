import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "vite-plus";
import { renderSite } from "../../website/site.js";

// #600 provides an explicitly empty local preview. #601 owns release capture input.
if (process.argv.slice(2).join(" ") !== "--preview") {
  throw new Error("Use --preview for the local no-capture build; released capture is #601.");
}
const output = resolve("dist/website");
for (const [path, html] of renderSite({ examples: [] })) {
  await mkdir(dirname(resolve(output, path)), { recursive: true });
  await writeFile(resolve(output, path), html);
}
await mkdir(resolve(output, "assets"), { recursive: true });
await writeFile(resolve(output, "assets/site.css"), await readFile("website/site.css"));
await build({
  configFile: false,
  build: {
    target: "es2023",
    outDir: resolve(output, "assets"),
    emptyOutDir: false,
    lib: { entry: resolve("website/copy.ts"), formats: ["es"], fileName: () => "copy.js" },
  },
});
console.log(`Local website preview: ${output} (no release capture; not published)`);
