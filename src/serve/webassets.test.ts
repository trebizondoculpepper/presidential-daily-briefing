/** Built frontend assets (#853, #684): each page served only from a complete JS/CSS pair. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { readWebAssetsFrom } from "./webassets.js";

describe("built web assets (#1141 review)", () => {
  it("serves each complete page and never combines one page's files across directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-web-"));
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      await mkdir(a);
      await mkdir(b);
      // a: Rules complete, Pipeline missing its CSS. b: only the Pipeline CSS.
      await writeFile(join(a, "rules.js"), "rules-js");
      await writeFile(join(a, "rules.css"), "rules-css");
      await writeFile(join(a, "pipeline.js"), "pipeline-js");
      await writeFile(join(b, "pipeline.css"), "pipeline-css");
      const dirs = [a, b].map((d) => pathToFileURL(`${d}/`));
      const assets = await readWebAssetsFrom(dirs);
      expect([...assets.keys()].sort()).toEqual(["/web/rules.css", "/web/rules.js"]);
      // Completing Pipeline in b serves it from b alone.
      await writeFile(join(b, "pipeline.js"), "pipeline-js-b");
      const both = await readWebAssetsFrom(dirs);
      expect(both.get("/web/pipeline.js")?.body).toBe("pipeline-js-b");
      expect(both.get("/web/pipeline.css")?.body).toBe("pipeline-css");
      expect(both.get("/web/rules.js")?.body).toBe("rules-js");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
