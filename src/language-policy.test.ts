import { describe, expect, it } from "vite-plus/test";
import { readdir, readFile } from "node:fs/promises";

describe("TypeScript source boundary (#91, #113, doc/design/typescript.md)", () => {
  it("allows only allowlisted non-TypeScript files in src/, scripts/ and doc/reports/examples/", async () => {
    const { LANGUAGE_SCOPE, languageViolations } = await import("./language-policy.js");
    const root = new URL("../", import.meta.url);
    // Generated output and dependencies are runtime artifacts, not handwritten source.
    const skipped = new Set(["node_modules", "dist"]);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name)) await walk(`${path}/`);
        } else files.push(path);
      }
    };
    for (const dir of LANGUAGE_SCOPE) await walk(dir);
    const sources = new Map<string, string>();
    for (const file of files) {
      if (/\.tsx?$/.test(file) && (file.startsWith("src/") || file.startsWith("scripts/"))) {
        sources.set(file, await readFile(new URL(file, root), "utf8"));
      }
    }
    expect(languageViolations(files, sources)).toEqual([]);
  });

  it("fails unlisted files, stale entries and imports of allowlisted files", async () => {
    const { languageViolations } = await import("./language-policy.js");
    const entry = {
      file: "scripts/helper.sh",
      purpose: "p",
      integrationBoundary: "b",
      runtimeRequirements: "r",
      supportedPlatforms: "s",
      validation: "v",
    };
    const none = new Map<string, string>();
    expect(languageViolations(["scripts/helper.sh"], none, [])).toEqual([
      "scripts/helper.sh: non-TypeScript file is not on the allowlist",
    ]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], none, [entry])).toEqual([]);
    expect(languageViolations(["src/cli.ts"], none, [entry])).toEqual([
      "scripts/helper.sh: allowlisted file does not exist",
    ]);
    const importing = new Map([["src/cli.ts", 'import x from "../scripts/helper.sh";']]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], importing, [entry])).toEqual([
      "src/cli.ts: imports allowlisted non-TypeScript file scripts/helper.sh",
    ]);
    const requiring = new Map([["scripts/a.ts", 'require("./helper.sh")']]);
    expect(languageViolations(["scripts/helper.sh"], requiring, [entry])).toHaveLength(1);
  });
});
