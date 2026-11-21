/**
 * The read-only Configuration view (#818, doc/design/serve-settings-page.md): the page shows what
 * the shared configuration services report — value, registered default, source and type — and
 * nothing else. Every boundary here is injected.
 */
import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import type { ConfigFileSystem } from "../config/config.js";
import { GLOBAL_CONFIG_FILE, GLOBAL_SCHEMA_VERSION } from "../config/globalconfig.js";
import { HttpFailure } from "./http.js";
import { globalConfiguration, projectConfiguration, readConfiguration } from "./configuration.js";
import { configurationBootstrapHtml } from "./configuration-page.js";

describe("configuration view (#818)", () => {
  const globalDir = "/global";

  function memoryFs(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files));
    const fs: ConfigFileSystem = {
      readText: async (path) => store.get(path) ?? null,
      writeText: async (path, text) => void store.set(path, text),
      rename: async (from, to) => {
        store.set(to, store.get(from)!);
        store.delete(from);
      },
      remove: async (path) => void store.delete(path),
      makeDirectory: async () => undefined,
    };
    return { fs, store };
  }

  it("shows every registered global key with its default and source", async () => {
    const memory = memoryFs();
    const view = await globalConfiguration({
      env: { PDB_CONFIG_DIR: globalDir },
      globalFs: memory.fs,
    });
    expect(view.scope).toBe("global");
    expect(view.repository).toBeNull();
    expect(view.state).toBe("ok");
    expect(view.path).toBe(join(globalDir, GLOBAL_CONFIG_FILE));
    expect(view.rows.map((row) => [row.key, row.value, row.source, row.type])).toEqual([
      ["serve.port", 4372, "default", "port"],
      ["serve.ttl", "5m", "default", "ttl"],
      ["serve.projects", [], "default", "projects"],
    ]);
  });

  it("reports an explicit global value as explicit, with the registered default still shown", async () => {
    const memory = memoryFs({
      [join(globalDir, GLOBAL_CONFIG_FILE)]:
        `schemaVersion = ${GLOBAL_SCHEMA_VERSION}\n\n[serve]\nport = 4800\n`,
    });
    const view = await globalConfiguration({
      env: { PDB_CONFIG_DIR: globalDir },
      globalFs: memory.fs,
    });
    const port = view.rows.find((row) => row.key === "serve.port")!;
    expect(port).toMatchObject({ value: 4800, defaultValue: 4372, source: "explicit" });
  });

  it("shows a project's registered keys, explicit or default, with type and description", async () => {
    const project = "/work/project";
    const memory = memoryFs({
      [join(project, ".github", "triage.toml")]: "schemaVersion = 1\n\nprocessGuide = true\n",
    });
    const view = await projectConfiguration(project, "owner/project", {
      repositoryFs: memory.fs,
    });
    expect(view.scope).toBe("project");
    expect(view.repository).toBe("owner/project");
    expect(view.state).toBe("ok");
    const guide = view.rows.find((row) => row.key === "processGuide")!;
    expect(guide).toMatchObject({
      value: true,
      defaultValue: false,
      source: "explicit",
      type: "boolean",
    });
    expect(guide.description).not.toBe("");
  });

  it("reads a --repo-only project as unsupported with registered defaults, never as empty", async () => {
    const view = await projectConfiguration(undefined, "owner/project", {});
    expect(view.scope).toBe("project");
    expect(view.state).toBe("unsupported");
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows.every((row) => row.source === "default")).toBe(true);
    expect(view.warnings[0]).toContain("--repo only");
  });

  it("reports a malformed project file as degraded with a readable reason", async () => {
    const project = "/work/bad";
    const memory = memoryFs({
      [join(project, ".github", "triage.toml")]: "not: [valid toml",
    });
    const view = await projectConfiguration(project, "owner/project", {
      repositoryFs: memory.fs,
    });
    expect(view.state).toBe("degraded");
    expect(view.warnings.length).toBeGreaterThan(0);
    // Registered defaults are still offered, never a silent empty table.
    expect(view.rows.length).toBeGreaterThan(0);
  });
});

describe("configuration read API (#818)", () => {
  const globalDir = "/api-global";
  const served = [{ repository: "owner/a", project: "/work/a" }];
  const memoryFs = (files: Record<string, string> = {}) => {
    const store = new Map(Object.entries(files));
    const fs: ConfigFileSystem = {
      readText: async (path) => store.get(path) ?? null,
      writeText: async (path, text) => void store.set(path, text),
      rename: async (from, to) => {
        store.set(to, store.get(from)!);
        store.delete(from);
      },
      remove: async (path) => void store.delete(path),
      makeDirectory: async () => undefined,
    };
    return fs;
  };
  // Injected boundaries: never read a real user configuration in tests.
  const runtime = () => ({ env: { PDB_CONFIG_DIR: globalDir }, globalFs: memoryFs() });
  const select = (
    list: readonly { repository: string; project?: string }[],
    repo: string | undefined,
  ) => {
    if (repo === undefined) throw new Error("no repo");
    const found = list.find((s) => s.repository.toLowerCase() === repo!.toLowerCase());
    if (!found)
      throw new HttpFailure(403, "REPOSITORY_NOT_SERVED", `${repo} is not served by this server.`);
    return found;
  };

  it("reads Global by default, accepting only the page's own parameter once", async () => {
    const read = await readConfiguration(new URLSearchParams(), served, runtime(), select);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.selected).toBeNull();
    expect(read.view.scope).toBe("global");
    for (const bad of [
      new URLSearchParams({ role: "implementer" }),
      new URLSearchParams("repo=a&repo=b"),
    ]) {
      const refused = await readConfiguration(bad, served, runtime(), select);
      expect(refused.ok).toBe(false);
    }
  });

  it("reads a served project's view when its repo is selected", async () => {
    const read = await readConfiguration(
      new URLSearchParams({ repo: "owner/a" }),
      served,
      runtime(),
      select,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.selected).toBe("owner/a");
    expect(read.view.scope).toBe("project");
  });

  it("refuses an unserved repository with the shared code", async () => {
    const refused = await readConfiguration(
      new URLSearchParams({ repo: "someone/else" }),
      served,
      runtime(),
      select,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});

describe("configuration bootstrap (#818)", () => {
  it("is a static bootstrap: shell, mount point and built assets, no config HTML", () => {
    const html = configurationBootstrapHtml(
      [{ repository: "owner/a", project: "/work/a" }],
      new URLSearchParams(),
    );
    expect(html).toContain('id="configuration-app"');
    expect(html).toContain('data-api="/api/v1/configuration"');
    expect(html).toContain('src="/web/configuration.js"');
    expect(html).toContain('href="/web/configuration.css"');
    // No service facts are rendered server-side.
    expect(html).not.toContain("serve.port");
    expect(html).not.toContain("processGuide");
    expect(html).toContain('<main id="content"');
    // #818 finding 4: the page opts out of the shared project-selection auto-redirect.
    expect(html).toContain('data-project-selection="none"');
  });

  it("tells the reader its assets are not built when they are missing", () => {
    const html = configurationBootstrapHtml(
      [{ repository: "owner/a", project: "/work/a" }],
      new URLSearchParams(),
      false,
    );
    expect(html).toContain("frontend assets are not built");
    expect(html).toContain("/api/v1/configuration");
    expect(html).not.toContain('id="configuration-app"');
  });
});
