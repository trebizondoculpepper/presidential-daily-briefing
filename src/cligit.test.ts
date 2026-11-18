import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

// Source guard for the #903 Git slice: the CLI composes the shared typed Git service and never
// falls back to the raw runner or composes Git argument lists itself.
describe("CLI Git boundary (#903)", () => {
  it("has no raw Git runner fallback or Git argument lists", async () => {
    const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bnodeGit\b/);
    expect(source).not.toMatch(/\["rev-parse"|\["remote"|\["ls-files"|\["check-ignore"/);
    expect(source).toMatch(/createAppServices\(\)/);
  });
});
