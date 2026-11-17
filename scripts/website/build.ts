import { CaptureFailure } from "./failure.js";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite-plus";
import { renderSite, type SiteInput } from "../../website/site.js";
import { conversations } from "../../website/conversations.js";

/** Caller verifies that this helper and all templates belong to the pinned release. */
export async function buildWebsite(input: SiteInput, output: string): Promise<void> {
  for (const [path, html] of renderSite(input)) {
    await mkdir(dirname(resolve(output, path)), { recursive: true });
    await writeFile(resolve(output, path), html);
  }
  await mkdir(resolve(output, "assets"), { recursive: true });
  await writeFile(resolve(output, "assets/site.css"), await readFile("website/site.css"));
  await mkdir(resolve(output, "assets/conversations"), { recursive: true });
  for (const { file } of conversations)
    await copyFile(
      resolve("website/assets/conversations", file),
      resolve(output, "assets/conversations", file),
    );
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      target: "es2023",
      outDir: resolve(output, "assets"),
      emptyOutDir: false,
      lib: { entry: resolve("website/copy.ts"), formats: ["es"], fileName: () => "copy.js" },
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(" ") !== "--preview") {
    throw new CaptureFailure(
      "Use --preview for a no-capture build; website:capture requires verified publication input.",
    );
  }
  const output = resolve("dist/website");
  await buildWebsite({ examples: [] }, output);
  console.log(`Local website preview: ${output} (no release capture; not published)`);
}
