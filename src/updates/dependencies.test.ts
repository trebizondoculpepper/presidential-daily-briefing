import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { dependencyReadiness, type ReadText } from "./dependencies.js";
import { localDoctor } from "../config/localdoctor.js";

const root = join("/", "src", "pdb");
const lock = (packages: Record<string, object>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "pdb" }, ...packages } });
const manifest = JSON.stringify({ name: "pdb", dependencies: { datascript: "1.8.1", zod: "4" } });
const expected = {
  "node_modules/datascript": { version: "1.8.1" },
  "node_modules/zod": { version: "4.6.7" },
  "node_modules/vitest": { version: "3.0.0", dev: true },
  "node_modules/@esbuild/win32-x64": { version: "0.25.0", optional: true },
};

/** An injected filesystem: relative paths under the root map to contents; absent is null. */
function files(entries: Record<string, string | Error>): ReadText {
  return async (path) => {
    const key = path
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    const value = entries[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
}
const installedModules = {
  "node_modules/datascript/package.json": "{}",
  "node_modules/zod/package.json": "{}",
};
const run = (entries: Record<string, string | Error>, installed = false) =>
  dependencyReadiness({ root, installed, readText: files(entries) });

describe("dependency readiness (#346)", () => {
  it("reports up to date when the install matches package-lock.json", async () => {
    const { "node_modules/@esbuild/win32-x64": _foreign, ...present } = expected;
    const check = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      "node_modules/.package-lock.json": lock(present),
      ...installedModules,
    });
    expect(check).toMatchObject({ id: "install.dependencies", status: "ok", next: [] });
  });

  it("reports a version mismatch as out of date with npm ci", async () => {
    const check = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      "node_modules/.package-lock.json": lock({
        ...expected,
        "node_modules/zod": { version: "3.0.0" },
      }),
      ...installedModules,
    });
    expect(check.status).toBe("invalid");
    expect(check.detail).toMatch(/out of date.*version differs.*zod/);
    expect(check.next[0]).toMatch(/^npm ci/);
  });

  it("reports a package missing from the install, naming it", async () => {
    const { "node_modules/datascript": _gone, ...older } = expected;
    const check = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      "node_modules/.package-lock.json": lock(older),
      "node_modules/zod/package.json": "{}",
    });
    expect(check.status).toBe("missing");
    expect(check.detail).toMatch(/missing: datascript/);
    expect(check.next[0]).toMatch(/^npm ci/);
  });

  it("does not trust the hidden lock when a runtime module is gone from disk", async () => {
    const check = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      "node_modules/.package-lock.json": lock(expected),
      "node_modules/zod/package.json": "{}",
    });
    expect(check.status).toBe("missing");
    expect(check.detail).toMatch(/datascript/);
  });

  it("reports no lockfile as unknown, never up to date", async () => {
    const check = await run({ "package.json": manifest, ...installedModules });
    expect(check.status).toBe("unknown");
    expect(check.detail).toMatch(/no package-lock\.json/);
  });

  it("reports an unreadable or unsupported lockfile as unknown", async () => {
    const unreadable = await run({
      "package.json": manifest,
      "package-lock.json": new Error("EACCES /private/path"),
    });
    expect(unreadable.status).toBe("unknown");
    expect(unreadable.detail).not.toMatch(/private/);
    const old = await run({
      "package.json": manifest,
      "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
    });
    expect(old.status).toBe("unknown");
  });

  it("is unknown without a hidden lock unless a runtime module is visibly absent", async () => {
    const present = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      ...installedModules,
    });
    expect(present.status).toBe("unknown");
    const none = await run({ "package.json": manifest, "package-lock.json": lock(expected) });
    expect(none.status).toBe("missing");
  });

  it("treats a dev-omitted install as unknown, not up to date", async () => {
    const { "node_modules/vitest": _dev, ...runtime } = expected;
    const check = await run({
      "package.json": manifest,
      "package-lock.json": lock(expected),
      "node_modules/.package-lock.json": lock(runtime),
      ...installedModules,
    });
    expect(check.status).toBe("unknown");
  });

  it("does not apply to an npm installation and never suggests npm ci there", async () => {
    const check = await run({}, true);
    expect(check.status).toBe("unsupported");
    expect(check.next).toEqual([]);
    expect(check.detail).toMatch(/reinstall the published package/);
  });

  it("is unknown when the installation root is unknown or reads stall past the deadline", async () => {
    expect((await dependencyReadiness({ root: null, installed: false })).status).toBe("unknown");
    const stalled = await dependencyReadiness({
      root,
      installed: false,
      readText: () => new Promise(() => undefined),
      deadlineMs: 20,
    });
    expect(stalled.status).toBe("unknown");
    expect(stalled.source).toBe("deadline");
  });

  it("is an independent doctor check that does not hide the others", async () => {
    const report = await localDoctor(
      {},
      {
        cwd: root,
        nodeVersion: "26.0.0",
        probe: async () => ({ code: null, stdout: "" }),
        dependencies: () => run({ "package.json": manifest }),
      },
    );
    expect(report.checks.find((c) => c.id === "install.dependencies")?.status).toBe("unknown");
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("ok");
    expect(report.checks.some((c) => c.id === "gh.available")).toBe(true);
  });
});
