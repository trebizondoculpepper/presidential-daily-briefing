/**
 * Minimal npm install hint (#1026, doc/design/onboarding-rules-files.md "Minimal npm install
 * hint"). The hook is a literal Node print in the required package manifest: no application
 * module, no devDependency, no checkout, no network, no credentials, no project writes. It
 * must behave identically from a packed install and from a clean source checkout before `dist`
 * exists, and it must never fail the install.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

const run = promisify(execFile);
const HINT = "Run pdb onboard in your project for onboarding instructions.";
const root = new URL("../..", import.meta.url);
/** A native path: `URL.pathname` keeps percent encoding and a leading slash on Windows. */
const rootPath = fileURLToPath(root);

async function hook(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  return manifest.scripts?.postinstall ?? "";
}

/** The JavaScript a `node -e "<code>"` hook runs. */
function code(hook: string): string {
  const match = /^node -e "(?<code>.*)"$/s.exec(hook);
  if (!match?.groups?.code) throw new Error(`unexpected postinstall hook: ${hook}`);
  return match.groups.code;
}

describe("npm postinstall onboarding hint (#1026)", () => {
  it("declares one literal Node print and nothing else", async () => {
    const declaration = await hook();
    expect(declaration).toBe(`node -e "console.log('${HINT}')"`);
    // Trivial by contract: no build artifact, checkout tool, client, network or credentials.
    for (const forbidden of ["tsx", "dist/", "gh ", "curl", "http", "npm ", "src/"])
      expect(declaration).not.toContain(forbidden);
  });

  it("prints the hint and exits zero", async () => {
    const { stdout, stderr } = await run(process.execPath, ["-e", code(await hook())], {
      cwd: rootPath,
    });
    expect(stdout.trim()).toBe(HINT);
    expect(stderr).toBe("");
  });

  // npm runs hooks through the platform shell, so the manifest literal must survive one.
  it.skipIf(process.platform === "win32")("survives a POSIX shell unchanged", async () => {
    const { stdout } = await run("/bin/sh", ["-c", await hook()], { cwd: rootPath });
    expect(stdout.trim()).toBe(HINT);
  });
});
