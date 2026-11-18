import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

// Source guard for #903: the CLI chooses GH executors in one place and shares one facade.
describe("CLI GH boundary (#903)", () => {
  it("chooses executors only in executorsOf and builds no per-command facade", async () => {
    const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source.match(/\?\? gh(Query|Rest|Run)\b/g)).toHaveLength(6);
    expect(source.match(/createGhService\(/g)).toHaveLength(1);
    expect(source).toMatch(/\(runtime\.rest \?\? ghRest\) === ghRest/);
  });
});
