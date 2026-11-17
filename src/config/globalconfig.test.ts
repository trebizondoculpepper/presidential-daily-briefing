import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import {
  GLOBAL_CONFIG_FILE,
  GLOBAL_DEFAULT_PORT,
  GLOBAL_DEFAULT_TTL,
  GLOBAL_KEYS,
  GLOBAL_SCHEMA_VERSION,
  GlobalConfigError,
  globalChanges,
  globalConfigDirectory,
  loadGlobalConfig,
  parseGlobalConfig,
  serializeGlobal,
  validateGlobalValue,
  writeGlobalConfig,
  type GlobalConfigFileSystem,
  type GlobalProject,
} from "./globalconfig.js";

describe("global configuration service (#804, doc/design/configuration-service.md)", () => {
  const dir = "/global";

  /** In-memory filesystem; `onBeforeRename` simulates a concurrent edit. */
  function memoryFs(initial?: string) {
    const path = join(dir, GLOBAL_CONFIG_FILE);
    const files = new Map<string, string>(initial === undefined ? [] : [[path, initial]]);
    const writes: { path?: string; text?: string }[] = [];
    let onBeforeRename: (() => void) | undefined;
    let fail = false;
    const fs: GlobalConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, text, _mode) => {
        writes.push({ path: file, text });
        files.set(file, text);
        // A concurrent edit lands between the temporary write and the final checks.
        if (file.endsWith(".tmp")) onBeforeRename?.();
      },
      rename: async (from, to) => {
        if (fail) throw new Error("rename EIO");
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (file) => void files.delete(file),
      makeDirectory: async () => undefined,
    };
    return {
      fs,
      files,
      writes,
      concurrent: (edit: () => void) => (onBeforeRename = edit),
      failRename: () => (fail = true),
    };
  }

  it("returns defaults when the file is absent and never writes", async () => {
    const memory = memoryFs();
    const config = await loadGlobalConfig(dir, memory.fs);
    expect(config.storedVersion).toBeNull();
    expect(config.settings.map((s) => [s.key, s.value, s.source])).toEqual([
      ["serve.port", GLOBAL_DEFAULT_PORT, "default"],
      ["serve.ttl", GLOBAL_DEFAULT_TTL, "default"],
      ["serve.projects", [], "default"],
    ]);
    expect(memory.writes).toEqual([]);
  });

  it("resolves the config directory from PDB_CONFIG_DIR, else the per-user pdb config dir", () => {
    expect(globalConfigDirectory({ PDB_CONFIG_DIR: "/custom" })).toBe("/custom");
    // The real home fallback is env-paths' config dir; it must end with the pdb name, no suffix.
    const real = globalConfigDirectory({});
    expect(typeof real).toBe("string");
  });

  it("parses an explicit value and reports it as explicit", async () => {
    const config = await parseGlobalConfig(
      `schemaVersion = 1\nserve.port = 4789\nserve.ttl = "7m"\n`,
      join(dir, GLOBAL_CONFIG_FILE),
    );
    expect(config.storedVersion).toBe(1);
    expect(config.settings.find((s) => s.key === "serve.port")?.source).toBe("explicit");
    expect(config.settings.find((s) => s.key === "serve.ttl")?.value).toBe("7m");
    expect(config.settings.find((s) => s.key === "serve.port")?.value).toBe(4789);
  });

  it("parses an ordered projects array with default host", async () => {
    const config = await parseGlobalConfig(
      `schemaVersion = 1
[[serve.projects]]
repository = "a/b"
host = "github.com"
localRoot = "/a/b"

[[serve.projects]]
repository = "c/d"
`,
      join(dir, GLOBAL_CONFIG_FILE),
    );
    const projects = config.explicit.get("serve.projects") as GlobalProject[];
    expect(projects).toEqual([
      { host: "github.com", repository: "a/b", localRoot: "/a/b" },
      { host: "github.com", repository: "c/d" },
    ]);
  });

  it("refuses malformed TOML without writing", async () => {
    const memory = memoryFs(`schemaVersion = 1\nserve.port = `);
    await expect(loadGlobalConfig(dir, memory.fs)).rejects.toMatchObject({ code: "malformed" });
    expect(memory.writes).toEqual([]);
  });

  it("refuses a structurally invalid parent table rather than treating it as absent (#849)", async () => {
    const memory = memoryFs(`schemaVersion = 1\nserve = "broken"\n`);
    await expect(loadGlobalConfig(dir, memory.fs)).rejects.toMatchObject({ code: "malformed" });
    expect(memory.writes).toEqual([]);
  });

  it("refuses unknown top-level configuration keys (#849)", async () => {
    const memory = memoryFs(`schemaVersion = 1\nother = 1\n`);
    await expect(loadGlobalConfig(dir, memory.fs)).rejects.toMatchObject({ code: "malformed" });
    expect(memory.writes).toEqual([]);
  });

  it("rejects a relative project localRoot through the verifier (#849)", async () => {
    await expect(
      validateGlobalValue("serve.projects", [{ repository: "a/b", localRoot: "../other" }]),
    ).rejects.toMatchObject({ code: "invalid-value" });
    // An absolute root passes the default verifier.
    await expect(
      validateGlobalValue("serve.projects", [{ repository: "a/b", localRoot: "/a/b" }]),
    ).resolves.toEqual([{ host: "github.com", repository: "a/b", localRoot: "/a/b" }]);
  });

  it("refuses a future schema version without writing", async () => {
    const memory = memoryFs(`schemaVersion = 99\n`);
    await expect(loadGlobalConfig(dir, memory.fs)).rejects.toMatchObject({
      code: "unsupported-version",
    });
    expect(memory.writes).toEqual([]);
  });

  it("validates the port typed value", async () => {
    await expect(validateGlobalValue("serve.port", 80)).resolves.toBe(80);
    await expect(validateGlobalValue("serve.port", 0)).rejects.toBeInstanceOf(GlobalConfigError);
    await expect(validateGlobalValue("serve.port", 70000)).rejects.toBeInstanceOf(
      GlobalConfigError,
    );
    await expect(validateGlobalValue("serve.port", "80")).rejects.toBeInstanceOf(GlobalConfigError);
  });

  it("validates the ttl typed value against the accepted range", async () => {
    await expect(validateGlobalValue("serve.ttl", "5m")).resolves.toBe("5m");
    await expect(validateGlobalValue("serve.ttl", "1h")).rejects.toBeInstanceOf(GlobalConfigError);
    await expect(validateGlobalValue("serve.ttl", "30s")).rejects.toBeInstanceOf(GlobalConfigError);
    await expect(validateGlobalValue("serve.ttl", 5)).rejects.toBeInstanceOf(GlobalConfigError);
  });

  it("validates a projects value", async () => {
    await expect(
      validateGlobalValue("serve.projects", [
        { repository: "a/b" },
        { repository: "c/d", host: "example.com" },
      ]),
    ).resolves.toEqual([
      { host: "github.com", repository: "a/b" },
      { host: "example.com", repository: "c/d" },
    ]);
    await expect(
      validateGlobalValue("serve.projects", [{ repository: "bad" }]),
    ).rejects.toBeInstanceOf(GlobalConfigError);
    await expect(
      validateGlobalValue("serve.projects", [{ repository: "a/b", extra: 1 }]),
    ).rejects.toBeInstanceOf(GlobalConfigError);
    await expect(validateGlobalValue("serve.projects", "nope")).rejects.toBeInstanceOf(
      GlobalConfigError,
    );
  });

  it("refuses unknown keys", async () => {
    await expect(validateGlobalValue("nope.value", 1)).rejects.toBeInstanceOf(GlobalConfigError);
  });

  it("writes a new file and can be read back", async () => {
    const memory = memoryFs();
    const result = await writeGlobalConfig(dir, new Map([["serve.port", 4800]]), { fs: memory.fs });
    expect(result.changed).toBe(true);
    expect(result.config.explicit.get("serve.port")).toBe(4800);
    const reloaded = await loadGlobalConfig(dir, memory.fs);
    expect(reloaded.explicit.get("serve.port")).toBe(4800);
    expect(reloaded.storedVersion).toBe(GLOBAL_SCHEMA_VERSION);
  });

  it("treats an equal write as a no-op", async () => {
    const memory = memoryFs();
    const first = await writeGlobalConfig(dir, new Map([["serve.port", 4800]]), { fs: memory.fs });
    expect(first.changed).toBe(true);
    const tempWritesAfterFirst = memory.writes.filter((w) => w.path?.endsWith(".tmp")).length;
    const second = await writeGlobalConfig(dir, new Map([["serve.port", 4800]]), { fs: memory.fs });
    expect(second.changed).toBe(false);
    // An unchanged write must not create or replace the target: no temp write, no rename.
    const tempWritesAfterSecond = memory.writes.filter((w) => w.path?.endsWith(".tmp")).length;
    expect(tempWritesAfterSecond).toBe(tempWritesAfterFirst);
  });

  it("rejects a stale save when the file changed before the rename", async () => {
    const memory = memoryFs(`schemaVersion = 1\nserve.port = 4800\n`);
    memory.concurrent(() => {
      memory.files.set(join(dir, GLOBAL_CONFIG_FILE), `schemaVersion = 1\nserve.port = 5000\n`);
    });
    await expect(
      writeGlobalConfig(dir, new Map([["serve.port", 5001]]), { fs: memory.fs }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("reports no-op and reverted edits through the change report", async () => {
    // A fresh long-lived consumer's in-memory baseline: nothing explicit, all defaults.
    const baseline = new Map<string, import("./globalconfig.js").GlobalValue>();
    const changed = new Map<string, import("./globalconfig.js").GlobalValue>();
    changed.set("serve.port", 4800);
    // Setting a key back to its effective default is not a change.
    const changes = globalChanges(baseline, changed);
    expect(changes).toEqual([{ key: "serve.port", oldValue: undefined, newValue: 4800 }]);
    // Reverting to the default clears the change.
    const reverted = globalChanges(baseline, new Map());
    expect(reverted).toEqual([]);
  });

  it("serialises back to parseable TOML with a schema version", async () => {
    const text = serializeGlobal(new Map<string, number>([["serve.port", 4800]]) as never);
    expect(text).toContain(`schemaVersion = ${GLOBAL_SCHEMA_VERSION}`);
    const parsed = await parseGlobalConfig(text, join(dir, GLOBAL_CONFIG_FILE));
    expect(parsed.explicit.get("serve.port")).toBe(4800);
  });

  it("keeps every registered key in the global registry", () => {
    expect(GLOBAL_KEYS.map((k) => k.key)).toEqual(["serve.port", "serve.ttl", "serve.projects"]);
  });
});
