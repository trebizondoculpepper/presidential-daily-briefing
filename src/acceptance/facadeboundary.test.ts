import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditFacadeBoundary, checkFacadeSource } from "./facadeboundary.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(srcDir, "..");

describe("application Git/GH facade boundary (#953)", () => {
  it("has zero direct git/gh subprocess or private-transport violations in src/", () => {
    expect(auditFacadeBoundary(srcDir)).toEqual([]);
  });

  it("reconciles every mapped module in doc/design/git-gh-module-migrations.md on disk", () => {
    const doc = readFileSync(join(repoRoot, "doc/design/git-gh-module-migrations.md"), "utf8");
    const matches = [...doc.matchAll(/^\|\s*`(src\/[^`]+)`\s*\|/gm)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(30);
    const missing = matches.filter((rel) => !existsSync(join(repoRoot, rel)));
    expect(missing).toEqual([]);
  });

  it("rejects direct git/gh subprocess execution and private transport imports in application modules", () => {
    const gitBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "workflow/example.ts"),
      `import { execFile } from "node:child_process";
execFile("git", ["status"], () => {});`,
    );
    expect(gitBypass).toMatchObject([
      { file: "workflow/example.ts", line: 2, rule: "direct-git-gh-exec" },
    ]);

    const ghBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "serve/example.ts"),
      `import * as cp from "node:child_process";
cp.spawn("gh", ["pr", "view"]);`,
    );
    expect(ghBypass).toMatchObject([
      { file: "serve/example.ts", line: 2, rule: "direct-git-gh-exec" },
    ]);

    const transportBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "briefing/example.ts"),
      `import { execFileTransport } from "../github/service/transport.js";
export const x = execFileTransport;`,
    );
    expect(transportBypass).toMatchObject([
      { file: "briefing/example.ts", line: 1, rule: "private-transport-import" },
    ]);

    const promisifyBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "workflow/promisified.ts"),
      `import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
await run("git", ["status"]);`,
    );
    expect(promisifyBypass).toMatchObject([
      { file: "workflow/promisified.ts", line: 4, rule: "direct-git-gh-exec" },
    ]);

    const shellBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "serve/shell.ts"),
      `import cp from "node:child_process";
cp.execSync("git status");`,
    );
    expect(shellBypass).toMatchObject([
      { file: "serve/shell.ts", line: 2, rule: "direct-git-gh-exec" },
    ]);

    const reexportBypass = checkFacadeSource(
      srcDir,
      join(srcDir, "workflow/reexport.ts"),
      `export { execFileTransport } from "../github/service/transport.js";`,
    );
    expect(reexportBypass).toMatchObject([
      { file: "workflow/reexport.ts", line: 1, rule: "private-transport-import" },
    ]);
  });

  it("allows documented adapter modules, unrelated node subprocesses, and tests", () => {
    expect(
      checkFacadeSource(
        srcDir,
        join(srcDir, "git/service.ts"),
        `import { execFile } from "node:child_process";
execFile("git", ["status"]);`,
      ),
    ).toEqual([]);

    expect(
      checkFacadeSource(
        srcDir,
        join(srcDir, "github/service/transport.ts"),
        `import { execFile } from "node:child_process";
execFile("gh", ["api", "/user"]);`,
      ),
    ).toEqual([]);

    expect(
      checkFacadeSource(
        srcDir,
        join(srcDir, "config/localdoctor.ts"),
        `import { execFile } from "node:child_process";
execFile("node", ["--version"]);`,
      ),
    ).toEqual([]);

    expect(
      checkFacadeSource(
        srcDir,
        join(srcDir, "workflow/example.test.ts"),
        `import { execFile } from "node:child_process";
execFile("git", ["status"]);`,
      ),
    ).toEqual([]);
  });
});
