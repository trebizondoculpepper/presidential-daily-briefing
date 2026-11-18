import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import type { ConfigFileSystem } from "../config/config.js";
import { GLOBAL_CONFIG_FILE, GLOBAL_SCHEMA_VERSION } from "../config/globalconfig.js";
import { globalConfiguration, projectConfiguration } from "./configuration.js";
import { configurationPage, configurationScript } from "./configuration-page.js";

/**
 * The read-only Configuration view (#818, doc/design/serve-settings-page.md): the page shows what
 * the shared configuration services report — value, registered default, source and type — and
 * nothing else. Every boundary here is injected.
 */
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
    const view = await projectConfiguration(project, "owner/project", { repositoryFs: memory.fs });
    expect(view.scope).toBe("project");
    expect(view.repository).toBe("owner/project");
    const guide = view.rows.find((row) => row.key === "processGuide")!;
    expect(guide).toMatchObject({
      value: true,
      defaultValue: false,
      source: "explicit",
      type: "boolean",
    });
    expect(guide.description).toMatch(/workflow guide/);
    const engine = view.rows.find((row) => row.key === "briefing.engine")!;
    expect(engine).toMatchObject({ value: "datalog", source: "default" });
    expect(engine.choices).toEqual(["typescript", "datalog"]);
  });

  it("reports an unreadable project as a warning with defaults, not an empty answer", async () => {
    const project = "/work/broken";
    const memory = memoryFs({ [join(project, ".github", "triage.toml")]: "schemaVersion = 9\n" });
    const view = await projectConfiguration(project, "owner/broken", { repositoryFs: memory.fs });
    expect(view.warnings.join(" ")).toMatch(/could not be read/);
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows.every((row) => row.source === "default")).toBe(true);
  });

  it("renders a page that reads the API and a script that assembles rows in the browser", () => {
    const page = configurationPage();
    expect(page).toContain("/configuration.js");
    expect(page).toContain('<th scope="col">Source</th>');
    const script = configurationScript();
    expect(script).toContain("/api/v1/configuration");
    // The server sends facts; the browser builds the table (doc/design/serve-api-first-frontend.md).
    expect(script).toContain("document.createElement");
    expect(script).not.toMatch(/^\s*import /m);
  });
});
