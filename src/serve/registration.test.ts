import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { GLOBAL_CONFIG_FILE, GLOBAL_SCHEMA_VERSION } from "../config/globalconfig.js";
import type { GlobalConfigFileSystem } from "../config/globalconfig.js";
import { RegistrationError, resolveServeProjects } from "./registration.js";

/**
 * Project resolution and registration at startup (#805,
 * doc/design/serve-startup-configuration.md "Resolve and register"). Every boundary is injected:
 * filesystem, git, repository resolver and clock-free. Nothing here reaches GitHub.
 */
describe("serve project resolution and registration (#805)", () => {
  const dir = "/global";
  const file = join(dir, GLOBAL_CONFIG_FILE);

  /** In-memory filesystem recording writes, so "nothing was registered" is checkable. */
  function memoryFs(initial?: string) {
    const files = new Map<string, string>(initial === undefined ? [] : [[file, initial]]);
    const writes: string[] = [];
    const fs: GlobalConfigFileSystem = {
      readText: async (path) => files.get(path) ?? null,
      writeText: async (path, text) => {
        writes.push(path);
        files.set(path, text);
      },
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (path) => void files.delete(path),
      makeDirectory: async () => undefined,
    };
    return { fs, files, writes };
  }

  /** A git boundary: `roots` maps an existing directory to its working-tree root. */
  function git(roots: Record<string, string>) {
    return async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] !== "rev-parse") throw new Error(`unexpected git ${args.join(" ")}`);
      const root = roots[cwd];
      if (root === undefined) throw new Error(`fatal: not a git repository: ${cwd}`);
      return `${root}\n`;
    };
  }

  const repositories: Record<string, string> = {
    "/work/project": "Owner/Project",
    "/work/project/sub": "Owner/Project",
    "/work/other": "owner/other",
  };

  const runtime = (fs: GlobalConfigFileSystem, cwd: string, roots: Record<string, string>) => ({
    cwd,
    git: git(roots),
    currentRepository: async (path?: string) => repositories[path ?? "/work/project"] ?? "",
    globalConfig: { dir, fs },
  });

  const config = (projects: string): string =>
    `schemaVersion = ${GLOBAL_SCHEMA_VERSION}\n\n${projects}`;

  it("serves the working directory's repository and registers it", async () => {
    const memory = memoryFs();
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      runtime(memory.fs, "/work/project/sub", { "/work/project/sub": "/work/project" }),
    );
    expect(result.served).toEqual([{ repository: "Owner/Project", project: "/work/project" }]);
    expect(result.registered).toEqual([
      { host: "github.com", repository: "Owner/Project", localRoot: "/work/project" },
    ]);
    expect(memory.files.has(file)).toBe(true);
    expect(memory.files.get(file)).toContain('repository = "Owner/Project"');
  });

  it("serves explicit targets outside any checkout and never fetches GitHub facts", async () => {
    const memory = memoryFs();
    let calls = 0;
    const result = await resolveServeProjects(
      { repos: ["owner/one"], projects: [] },
      {
        cwd: "/not/a/checkout",
        git: git({}),
        currentRepository: async () => {
          calls++;
          return "";
        },
        globalConfig: { dir, fs: memory.fs },
      },
    );
    expect(result.served).toEqual([{ repository: "owner/one" }]);
    expect(calls).toBe(0);
    // An explicit repo-only target is a registration too (#805 "register projects").
    expect(result.registered).toEqual([{ host: "github.com", repository: "owner/one" }]);
  });

  it("serves saved registrations when no target is given, in stored order", async () => {
    const memory = memoryFs(
      config(
        `[serve]\nport = 4372\nprojects = [{ repository = "owner/saved" }, { repository = "owner/other", localRoot = "/work/other" }]\n`,
      ),
    );
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      runtime(memory.fs, "/not/a/checkout", { "/work/other": "/work/other" }),
    );
    expect(result.served).toEqual([
      { repository: "owner/saved" },
      { repository: "owner/other", project: "/work/other" },
    ]);
    expect(memory.writes).toEqual([]);
  });

  it("keeps an enterprise registration independent from the same github.com repository", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ host = "ghe.example.com", repository = "owner/one" }]\n`),
    );
    const result = await resolveServeProjects(
      { repos: ["owner/one"], projects: [] },
      runtime(memory.fs, "/not/a/checkout", {}),
    );
    // The github.com target is served and appended, never merged into the enterprise entry.
    expect(result.served).toEqual([{ repository: "owner/one" }]);
    expect(result.saved).toEqual([
      { host: "ghe.example.com", repository: "owner/one" },
      { host: "github.com", repository: "owner/one" },
    ]);
    expect(result.registered).toEqual([{ host: "github.com", repository: "owner/one" }]);
  });

  it("refuses to serve a saved registration for another GitHub host", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ host = "ghe.example.com", repository = "owner/a" }]\n`),
    );
    const result = await resolveServeProjects(
      { repos: ["owner/one"], projects: [] },
      runtime(memory.fs, "/not/a/checkout", {}),
    );
    expect(result.served).toEqual([{ repository: "owner/one" }]);
    expect(result.diagnostics.join("\n")).toMatch(
      /ghe\.example\.com, which this build cannot serve/,
    );
    // The registration is kept, not deleted by a read.
    expect(result.saved.some((entry) => entry.host === "ghe.example.com")).toBe(true);
  });

  it("refuses to serve a saved root that is now another repository", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ repository = "owner/a", localRoot = "/work/reused" }]\n`),
    );
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      {
        ...runtime(memory.fs, "/not/a/checkout", { "/work/reused": "/work/reused" }),
        currentRepository: async () => "owner/b",
      },
    );
    expect(result.served).toEqual([{ repository: "owner/a" }]);
    expect(result.diagnostics.join("\n")).toMatch(/is now owner\/b, not owner\/a/);
  });

  it("keeps a saved root whose identity cannot be read right now", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ repository = "owner/a", localRoot = "/work/a" }]\n`),
    );
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      {
        ...runtime(memory.fs, "/not/a/checkout", { "/work/a": "/work/a" }),
        currentRepository: async () => {
          throw new Error("gh: not authenticated");
        },
      },
    );
    // A transient failure must not silently drop a registration.
    expect(result.served).toEqual([{ repository: "owner/a", project: "/work/a" }]);
    expect(result.diagnostics.join("\n")).toMatch(/could not be identified/);
  });

  it("records explicit repo-only targets, and refuses a stale registration write", async () => {
    const memory = memoryFs();
    const first = await resolveServeProjects(
      { repos: ["owner/one"], projects: [] },
      runtime(memory.fs, "/not/a/checkout", {}),
    );
    expect(first.registered).toEqual([{ host: "github.com", repository: "owner/one" }]);
    expect(memory.files.get(file)).toContain('repository = "owner/one"');

    // A second startup whose baseline is replaced before its write must not overwrite it.
    const stale = memoryFs(config(`[serve]\nprojects = [{ repository = "owner/a" }]\n`));
    const reads = new Map<string, number>();
    const racing: GlobalConfigFileSystem = {
      ...stale.fs,
      readText: async (path) => {
        const count = (reads.get(path) ?? 0) + 1;
        reads.set(path, count);
        const text = await stale.fs.readText(path);
        // The first read is the baseline; a concurrent writer changes the file afterwards.
        return count === 1 ? text : `${text}# another startup\n`;
      },
    };
    await expect(
      resolveServeProjects(
        { repos: ["owner/new"], projects: [] },
        runtime(racing, "/not/a/checkout", {}),
      ),
    ).rejects.toThrow(/could not be updated/);
  });

  it("reports a saved root that moved and serves its repository without the local project", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ repository = "owner/gone", localRoot = "/work/gone" }]\n`),
    );
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      runtime(memory.fs, "/work/project", { "/work/project": "/work/project" }),
    );
    expect(result.served).toEqual([
      { repository: "owner/gone" },
      { repository: "Owner/Project", project: "/work/project" },
    ]);
    expect(result.diagnostics.join("\n")).toMatch(/\/work\/gone .*missing/);
  });

  it("lets an explicit repo-only target keep a saved local root, and a verified root refine one", async () => {
    const kept = memoryFs(
      config(`[serve]\nprojects = [{ repository = "owner/other", localRoot = "/work/other" }]\n`),
    );
    const keptResult = await resolveServeProjects(
      { repos: ["owner/other"], projects: [] },
      runtime(kept.fs, "/not/a/checkout", { "/work/other": "/work/other" }),
    );
    expect(keptResult.served).toEqual([{ repository: "owner/other", project: "/work/other" }]);

    const refined = memoryFs(config(`[serve]\nprojects = [{ repository = "owner/other" }]\n`));
    const refinedResult = await resolveServeProjects(
      { repos: [], projects: ["/work/other"] },
      runtime(refined.fs, "/not/a/checkout", { "/work/other": "/work/other" }),
    );
    expect(refinedResult.served).toEqual([{ repository: "owner/other", project: "/work/other" }]);
    expect(refinedResult.saved).toEqual([
      { host: "github.com", repository: "owner/other", localRoot: "/work/other" },
    ]);
  });

  it("refuses two different local roots for one repository without writing", async () => {
    const memory = memoryFs(
      config(`[serve]\nprojects = [{ repository = "owner/other", localRoot = "/work/other" }]\n`),
    );
    await expect(
      resolveServeProjects(
        { repos: [], projects: ["/work/clone"] },
        {
          ...runtime(memory.fs, "/not/a/checkout", {
            "/work/other": "/work/other",
            "/work/clone": "/work/clone",
          }),
          currentRepository: async () => "owner/other",
        },
      ),
    ).rejects.toBeInstanceOf(RegistrationError);
    expect(memory.writes).toEqual([]);
  });

  it("fails an invalid explicit target before registering anything", async () => {
    const memory = memoryFs();
    await expect(
      resolveServeProjects(
        { repos: ["owner/fine"], projects: ["/not/a/checkout"] },
        runtime(memory.fs, "/not/a/checkout", {}),
      ),
    ).rejects.toThrow(/not inside a Git checkout/);
    expect(memory.writes).toEqual([]);
  });

  it("says nothing to serve when no target, registration or checkout exists", async () => {
    const memory = memoryFs();
    await expect(
      resolveServeProjects({ repos: [], projects: [] }, runtime(memory.fs, "/not/a/checkout", {})),
    ).rejects.toThrow(/nothing to serve/);
    expect(memory.writes).toEqual([]);
  });

  it("refuses a malformed saved configuration without registering or starting", async () => {
    const memory = memoryFs("schemaVersion = 1\n\n[serve]\nprot = 4800\n");
    await expect(
      resolveServeProjects(
        { repos: ["owner/one"], projects: [] },
        runtime(memory.fs, "/work/project", { "/work/project": "/work/project" }),
      ),
    ).rejects.toThrow(/cannot be used/);
    expect(memory.writes).toEqual([]);
  });

  it("does not rewrite an unchanged registration set", async () => {
    const saved = config(
      `[serve]\nprojects = [{ repository = "owner/other", localRoot = "/work/other" }]\n`,
    );
    const memory = memoryFs(saved);
    const result = await resolveServeProjects(
      { repos: [], projects: ["/work/other"] },
      runtime(memory.fs, "/not/a/checkout", { "/work/other": "/work/other" }),
    );
    expect(result.registered).toEqual([]);
    expect(memory.writes).toEqual([]);
  });
});
