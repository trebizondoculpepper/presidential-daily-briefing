import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import {
  CONFIG_PATH,
  ConfigError,
  convertConfig,
  LEGACY_CONFIG_PATH,
  TOML_CONFIG_PATH,
  githubRepositories,
  loadConfig,
  nodeFileSystem,
  parseConfig,
  retiredKeyNotices,
  resolveRepositoryTarget,
  settingFor,
  updateConfig,
  type ConfigFileSystem,
  type ConfigSchema,
  type GitRunner,
} from "./config.js";

describe("repository configuration service (#116, doc/design/repository-configuration.md)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  /** In-memory filesystem; `onBeforeRename` simulates a concurrent edit. */
  function memoryFs(initial?: string) {
    const files = new Map<string, string>(initial === undefined ? [] : [[path, initial]]);
    const writes: string[] = [];
    let onBeforeRename: (() => void) | undefined;
    let failRename = false;
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, text) => {
        writes.push(file);
        files.set(file, text);
      },
      rename: async (from, to) => {
        onBeforeRename?.();
        if (failRename) throw new Error("disk full");
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
      failRename: () => (failRename = true),
    };
  }
  const target = { root, repository: "owner/name" };
  const token = () => "t";

  it("defaults complexity on when the file is absent, with no field setting", async () => {
    const memory = memoryFs();
    const config = await loadConfig(root, memory.fs);
    expect(config.storedVersion).toBeNull();
    expect(config.settings).toEqual([
      { key: "briefing.engine", value: "datalog", source: "default" },
      { key: "complexity.enabled", value: true, source: "default" },
      { key: "impact.enabled", value: true, source: "default" },
      { key: "review.policy", value: null, source: "default" },
      { key: "processGuide", value: false, source: "default" },
    ]);
    expect(config.retired).toEqual([]);
    expect(memory.writes).toEqual([]);
  });

  it("treats an explicitly stored default as explicit", () => {
    const config = parseConfig('{"schemaVersion":1,"complexity":{"enabled":true}}', undefined);
    expect(settingFor(config, "complexity.enabled").source).toBe("explicit");
    expect(settingFor(config, "processGuide").source).toBe("default");
  });

  it("reports explicit settings and their source", async () => {
    const memory = memoryFs(
      '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"PVTF_1"}}',
    );
    const config = await loadConfig(root, memory.fs);
    expect(settingFor(config, "complexity.enabled")).toEqual({
      key: "complexity.enabled",
      value: false,
      source: "explicit",
    });
    expect(() => settingFor(config, "complexity.colour")).toThrow(ConfigError);
  });

  it("ignores the retired complexity.fieldId with a diagnostic, never a failure (#153)", async () => {
    const raw = '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"PVTF_1"}}';
    const memory = memoryFs(raw);
    const config = await loadConfig(root, memory.fs);
    expect(config.retired).toEqual(["complexity.fieldId"]);
    expect([...config.explicit.keys()]).toEqual(["complexity.enabled"]);
    expect(() => settingFor(config, "complexity.fieldId")).toThrow(ConfigError);
    expect(retiredKeyNotices(config)).toEqual([
      expect.objectContaining({
        key: "complexity.fieldId",
        next: "pdb config set complexity.enabled false",
      }),
    ]);
    expect(memory.files.get(path)).toBe(raw);
    expect(memory.writes).toEqual([]);
    // The suggested command-mediated write drops the retired key and keeps everything else.
    const result = await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect(result.changed).toBe(true);
    expect(result.config.retired).toEqual([]);
    expect(JSON.parse(memory.files.get(path)!)).toEqual({
      schemaVersion: 1,
      complexity: { enabled: false },
    });
  });

  it.each([
    ["not json", "malformed"],
    ["[]", "malformed"],
    ['{"complexity":{}}', "malformed"],
    ['{"schemaVersion":2}', "unsupported-version"],
    ['{"schemaVersion":1,"complexity":{"enabled":"yes"}}', "incompatible"],
    ['{"schemaVersion":1,"token":"secret"}', "incompatible"],
    // Empty objects must not bypass validation (Codex review on #131).
    ['{"schemaVersion":1,"complexity":{"enabled":{}}}', "incompatible"],
    ['{"schemaVersion":1,"futureSetting":{}}', "incompatible"],
    ['{"schemaVersion":1,"complexity":{"enabled":true,"later":{}}}', "incompatible"],
  ])("refuses %s without touching the file", async (raw, code) => {
    const memory = memoryFs(raw);
    await expect(loadConfig(root, memory.fs)).rejects.toMatchObject({ code });
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs: memory.fs, token }),
    ).rejects.toMatchObject({ code });
    expect(memory.files.get(path)).toBe(raw);
    expect(memory.writes).toEqual([]);
  });

  it("migrates older schemas in memory on read and only persists on write", async () => {
    const schema: ConfigSchema = {
      version: 2,
      keys: [
        {
          key: "complexity.enabled",
          type: "boolean",
          nullable: false,
          defaultValue: true,
          description: "",
        },
        { key: "other", type: "string", nullable: true, defaultValue: null, description: "" },
      ],
      migrations: [
        {
          from: 1,
          migrate: ({ estimates, ...rest }) => ({ ...rest, complexity: { enabled: estimates } }),
        },
      ],
    };
    const old = '{"schemaVersion":1,"estimates":false,"other":"kept"}';
    const memory = memoryFs(old);
    const read = await loadConfig(root, memory.fs, schema);
    expect(read.storedVersion).toBe(1);
    expect(read.explicit.get("complexity.enabled")).toBe(false);
    expect(memory.files.get(path)).toBe(old);

    const written = await updateConfig(target, new Map([["other", "changed"]]), {
      fs: memory.fs,
      schema,
      token,
    });
    expect(written.changed).toBe(true);
    expect(JSON.parse(memory.files.get(path)!)).toEqual({
      schemaVersion: 2,
      complexity: { enabled: false },
      other: "changed",
    });
  });

  it("refuses an older schema with no registered migration", async () => {
    const memory = memoryFs('{"schemaVersion":1}');
    const schema: ConfigSchema = { version: 2, keys: [], migrations: [] };
    await expect(loadConfig(root, memory.fs, schema)).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  it("writes atomically, preserves unrelated settings and skips equal writes", async () => {
    const memory = memoryFs('{"schemaVersion":1,"processGuide":false}');
    const result = await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect(result.changed).toBe(true);
    expect(memory.writes).toEqual([`${path}.t.tmp`]);
    expect(memory.files.has(`${path}.t.tmp`)).toBe(false);
    expect(JSON.parse(memory.files.get(path)!)).toEqual({
      schemaVersion: 1,
      complexity: { enabled: false },
      processGuide: false,
    });
    const again = await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect(again.changed).toBe(false);
    expect(memory.writes).toHaveLength(1);
  });

  it("unsets a key back to its default and creates no file for default-only state", async () => {
    const memory = memoryFs('{"schemaVersion":1,"processGuide":false}');
    await updateConfig(target, new Map([["processGuide", undefined]]), {
      fs: memory.fs,
      token,
    });
    expect(JSON.parse(memory.files.get(path)!)).toEqual({ schemaVersion: 1 });
    const empty = memoryFs();
    const result = await updateConfig(target, new Map([["processGuide", undefined]]), {
      fs: empty.fs,
      token,
    });
    expect(result.changed).toBe(false);
    expect(empty.files.size).toBe(0);
  });

  it("validates values against the registry before writing", async () => {
    const memory = memoryFs();
    for (const [key, value] of [
      ["complexity.enabled", "false"],
      ["complexity.enabled", null],
      ["complexity.fieldId", "PVTF_1"],
      ["complexity.colour", true],
    ] as const) {
      await expect(
        updateConfig(target, new Map([[key, value]]), { fs: memory.fs, token }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
    expect(memory.writes).toEqual([]);
  });

  it("detects an intervening edit and leaves the other writer's file in place", async () => {
    const memory = memoryFs('{"schemaVersion":1}');
    const theirs = '{"schemaVersion":1,"processGuide":false}';
    const fs: ConfigFileSystem = {
      ...memory.fs,
      writeText: async (file, text) => {
        await memory.fs.writeText(file, text);
        memory.files.set(path, theirs);
      },
    };
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs, token }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(memory.files.get(path)).toBe(theirs);
    expect(memory.files.has(`${path}.t.tmp`)).toBe(false);
  });

  it("removes the temporary file and keeps the original when the replace fails", async () => {
    const original = '{"schemaVersion":1}';
    const memory = memoryFs(original);
    memory.failRename();
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs: memory.fs, token }),
    ).rejects.toThrow("disk full");
    expect(memory.files.get(path)).toBe(original);
    expect([...memory.files.keys()]).toEqual([path]);
  });

  it("writes through the real filesystem into a temporary checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triage-config-"));
    try {
      const local = { root: directory, repository: "owner/name" };
      await updateConfig(local, new Map([["complexity.enabled", false]]));
      const config = await loadConfig(directory);
      expect(settingFor(config, "complexity.enabled").source).toBe("explicit");
      // A repository with no settings file starts on the TOML store (#160).
      expect(await readdir(join(directory, ".github"))).toEqual(["triage.toml"]);
      await expect(nodeFileSystem.readText(join(directory, "missing"))).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("repository resolution before writes", () => {
    const git =
      (remotes: string, top = "/repo"): GitRunner =>
      async (args) =>
        args[0] === "rev-parse" ? `${top}\n` : remotes;

    it("parses GitHub remotes in common forms", () => {
      expect(
        githubRepositories(
          "origin\tgit@github.com:Owner/Name.git (fetch)\nup\thttps://github.com/a/b (push)\nx\thttps://gitlab.com/c/d (fetch)",
        ),
      ).toEqual(["owner/name", "a/b"]);
    });

    it("only accepts remotes whose host is exactly github.com", () => {
      expect(
        githubRepositories(
          [
            "a\thttps://notgithub.com/evil/one.git (fetch)",
            "b\t/mirrors/github.com/evil/two.git (fetch)",
            "c\thttps://example.com/github.com/evil/three.git (fetch)",
            "d\tgit@github.com.evil.net:evil/four.git (fetch)",
            "e\t../github.com/evil/five (fetch)",
            "f\tssh://git@GitHub.com/Ok/One.git (fetch)",
            "g\tgit@GITHUB.COM:ok/two (fetch)",
            "h\thttps://user@github.com/ok/three/ (fetch)",
          ].join("\n"),
        ),
      ).toEqual(["ok/one", "ok/two", "ok/three"]);
    });

    it("accepts a checkout whose remote matches --repo", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo/src",
          "owner/name",
          git("origin\thttps://github.com/owner/name.git (fetch)"),
        ),
      ).resolves.toEqual({ root: "/repo", repository: "owner/name" });
    });

    it("refuses when --repo names an unrelated repository", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo",
          "other/project",
          git("origin\thttps://github.com/owner/name (fetch)"),
        ),
      ).rejects.toMatchObject({ code: "repository-mismatch" });
    });

    it("refuses ambiguous remotes without --repo and non-checkouts", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo",
          undefined,
          git("a\thttps://github.com/x/y (fetch)\nb\thttps://github.com/p/q (fetch)"),
        ),
      ).rejects.toMatchObject({ code: "repository-mismatch" });
      const failing: GitRunner = async () => {
        throw new Error("not a git repository");
      };
      await expect(resolveRepositoryTarget("/tmp", undefined, failing)).rejects.toMatchObject({
        code: "not-a-repository",
      });
    });
  });
});

describe("shared repository settings in TOML (#160, doc/design/configuration-formats.md)", () => {
  const root = "/repo";
  const tomlPath = join(root, TOML_CONFIG_PATH);
  const jsonPath = join(root, LEGACY_CONFIG_PATH);
  const target = { root, repository: "owner/name" };
  const token = () => "t";
  const JSON_SETTINGS =
    '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"F_1"},"processGuide":false}';
  const TOML_SETTINGS =
    "schemaVersion = 1\nprocessGuide = false\n\n[complexity]\nenabled = false\n";

  /** In-memory filesystem with hooks for concurrent edits and failures. */
  function memoryFs(initial: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(initial));
    const hooks: {
      beforeRename?: () => void;
      afterRename?: () => void;
      failRemove?: string;
      afterRead?: (file: string) => void;
    } = {};
    const fs: ConfigFileSystem = {
      readText: async (file) => {
        const text = files.get(file) ?? null;
        hooks.afterRead?.(file);
        return text;
      },
      writeText: async (file, text) => {
        if (files.has(file)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        files.set(file, text);
        // A concurrent edit lands between the temporary write and the final checks.
        if (file.endsWith(".tmp")) hooks.beforeRename?.();
      },
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
        hooks.afterRename?.();
      },
      remove: async (file) => {
        if (file === hooks.failRemove)
          throw Object.assign(new Error("EACCES"), { code: "EACCES", path: file });
        files.delete(file);
      },
      makeDirectory: async () => undefined,
    };
    return { fs, files, hooks };
  }

  it("creates TOML for a new repository, with typed values and a header", async () => {
    const memory = memoryFs();
    await updateConfig(target, new Map([["processGuide", false]]), { fs: memory.fs, token });
    const text = memory.files.get(tomlPath)!;
    expect(text.startsWith("# Shared pdb repository settings")).toBe(true);
    expect(text).toContain("schemaVersion = 1\nprocessGuide = false\n");
    expect([...memory.files.keys()]).toEqual([tomlPath]);
    const config = await loadConfig(root, memory.fs);
    expect(config).toMatchObject({ format: "toml", path: TOML_CONFIG_PATH, storedVersion: 1 });
    expect(settingFor(config, "processGuide")).toMatchObject({ value: false, source: "explicit" });
    expect(settingFor(config, "complexity.enabled").source).toBe("default");
  });

  it("keeps reading and setting an unconverted JSON file in place, never converting", async () => {
    const memory = memoryFs({ [jsonPath]: '{"schemaVersion":1,"processGuide":false}' });
    const config = await loadConfig(root, memory.fs);
    expect(config).toMatchObject({ format: "json", path: LEGACY_CONFIG_PATH });
    await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect([...memory.files.keys()]).toEqual([jsonPath]);
    expect(JSON.parse(memory.files.get(jsonPath)!)).toEqual({
      schemaVersion: 1,
      complexity: { enabled: false },
      processGuide: false,
    });
  });

  it("refuses both files when they agree, pointing at convert, and never writes", async () => {
    const memory = memoryFs({
      [jsonPath]: '{"schemaVersion":1,"processGuide":false,"complexity":{"enabled":false}}',
      [tomlPath]: TOML_SETTINGS,
    });
    const before = new Map(memory.files);
    const error = await loadConfig(root, memory.fs).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "duplicate-config" });
    expect((error as ConfigError).message).toContain("same settings");
    expect((error as ConfigError).recovery).toContain("\npdb config convert");
    await expect(
      updateConfig(target, new Map([["processGuide", true]]), { fs: memory.fs, token }),
    ).rejects.toMatchObject({ code: "duplicate-config" });
    expect(memory.files).toEqual(before);
  });

  it("refuses disagreeing files without preferring either, naming keys and exact commands", async () => {
    const memory = memoryFs({
      [jsonPath]: '{"schemaVersion":1,"processGuide":true}',
      [tomlPath]: TOML_SETTINGS,
    });
    const error = (await loadConfig(root, memory.fs).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("duplicate-config");
    expect(error.message).toContain("disagree on complexity.enabled, processGuide");
    expect(error.recovery.split("\n").slice(1)).toEqual([
      "pdb config convert --prefer toml",
      "pdb config convert --prefer json",
    ]);
    expect(error.recovery).not.toContain("#");
    await expect(convertConfig(target, { fs: memory.fs, token })).rejects.toMatchObject({
      code: "duplicate-config",
    });
    expect(memory.files.get(jsonPath)).toBe('{"schemaVersion":1,"processGuide":true}');
  });

  it("converts JSON to verified TOML, removes the JSON and drops the retired fieldId", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    const result = await convertConfig(target, { fs: memory.fs, token });
    expect(result).toMatchObject({
      status: "converted",
      wroteToml: true,
      removedJson: true,
      droppedRetired: ["complexity.fieldId"],
    });
    expect([...memory.files.keys()]).toEqual([tomlPath]);
    const text = memory.files.get(tomlPath)!;
    expect(text).not.toContain("fieldId");
    const config = await loadConfig(root, memory.fs);
    expect(config.format).toBe("toml");
    expect(Object.fromEntries(config.explicit)).toEqual({
      "complexity.enabled": false,
      processGuide: false,
    });
    // Converting again is a no-op.
    expect(await convertConfig(target, { fs: memory.fs, token })).toMatchObject({
      status: "already-toml",
      wroteToml: false,
      removedJson: false,
    });
  });

  it("creates nothing when there is nothing to convert", async () => {
    const memory = memoryFs();
    expect(await convertConfig(target, { fs: memory.fs, token })).toMatchObject({
      status: "nothing-to-convert",
    });
    expect(memory.files.size).toBe(0);
  });

  it.each([
    ["malformed", "{not json"],
    ["unsupported-version", '{"schemaVersion":99}'],
    ["incompatible", '{"schemaVersion":1,"unknown":true}'],
  ])("refuses to convert %s JSON and changes nothing", async (code, raw) => {
    const memory = memoryFs({ [jsonPath]: raw });
    await expect(convertConfig(target, { fs: memory.fs, token })).rejects.toMatchObject({ code });
    expect([...memory.files]).toEqual([[jsonPath, raw]]);
  });

  it("refuses a conversion when the JSON changes before the TOML is placed", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    memory.hooks.beforeRename = () =>
      memory.files.set(jsonPath, '{"schemaVersion":1,"processGuide":true}');
    await expect(convertConfig(target, { fs: memory.fs, token })).rejects.toMatchObject({
      code: "conflict",
    });
    expect([...memory.files.keys()]).toEqual([jsonPath]);
  });

  it("keeps the JSON when it changes after the TOML is written, reporting partial conversion", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    memory.hooks.afterRename = () =>
      memory.files.set(jsonPath, '{"schemaVersion":1,"processGuide":true}');
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("partial-conversion");
    expect(error.recovery).toContain("pdb config convert --prefer json");
    expect(memory.files.get(jsonPath)).toBe('{"schemaVersion":1,"processGuide":true}');
    expect(memory.files.has(tomlPath)).toBe(true);
  });

  it("reports a JSON file it could not remove, and a rerun finishes the conversion", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    memory.hooks.failRemove = jsonPath;
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("partial-conversion");
    expect(error.message).toContain("verified settings");
    expect(error.recovery.split("\n").at(-1)).toBe("pdb config convert");
    expect(memory.files.get(jsonPath)).toBe(JSON_SETTINGS);
    memory.hooks.failRemove = undefined;
    // The retired key is ignored when comparing, so the stores agree and the JSON is removed.
    expect(await convertConfig(target, { fs: memory.fs, token })).toMatchObject({
      status: "removed-json",
      wroteToml: false,
    });
    expect([...memory.files.keys()]).toEqual([tomlPath]);
  });

  it("keeps the JSON when the written TOML does not verify", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    memory.hooks.afterRename = () => memory.files.set(tomlPath, "schemaVersion = 1\n");
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("partial-conversion");
    expect(error.message).toContain("could not be verified");
    expect(memory.files.get(jsonPath)).toBe(JSON_SETTINGS);
  });

  it.each([
    ["removed", (files: Map<string, string>) => files.delete(tomlPath)],
    [
      "changed",
      (files: Map<string, string>) =>
        files.set(tomlPath, "schemaVersion = 1\nprocessGuide = true\n"),
    ],
    ["made unparsable", (files: Map<string, string>) => files.set(tomlPath, "schemaVersion = \n")],
  ])(
    "keeps the JSON when the retained TOML is %s after it was read (--prefer toml)",
    async (_label, mutate) => {
      const json = '{"schemaVersion":1,"processGuide":true}';
      const memory = memoryFs({ [jsonPath]: json, [tomlPath]: TOML_SETTINGS });
      let tomlReads = 0;
      memory.hooks.afterRead = (file) => {
        if (file === tomlPath && ++tomlReads === 1) mutate(memory.files);
      };
      const error = (await convertConfig(target, { fs: memory.fs, token, prefer: "toml" }).catch(
        (caught: unknown) => caught,
      )) as ConfigError;
      expect(error.code).toBe("partial-conversion");
      expect(error.recovery).toContain("pdb config convert --prefer");
      expect(memory.files.get(jsonPath)).toBe(json);
    },
  );

  it("keeps the JSON when the written TOML disappears after verification", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    let tomlReads = 0;
    memory.hooks.afterRead = (file) => {
      // Reads: snapshot, pre-rename check, verification; then delete before the final recheck.
      if (file === tomlPath && ++tomlReads === 3) memory.files.delete(tomlPath);
    };
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("partial-conversion");
    expect(memory.files.get(jsonPath)).toBe(JSON_SETTINGS);
  });

  it("follows the suggested --prefer json recovery after a written TOML fails to parse", async () => {
    const memory = memoryFs({ [jsonPath]: JSON_SETTINGS });
    memory.hooks.afterRename = () => memory.files.set(tomlPath, "schemaVersion = \n");
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("partial-conversion");
    const command = error.recovery.split("\n").at(-1)!;
    expect(command).toBe("pdb config convert --prefer json");
    memory.hooks.afterRename = undefined;
    expect(await convertConfig(target, { fs: memory.fs, token, prefer: "json" })).toMatchObject({
      status: "replaced-toml",
      removedJson: true,
    });
    expect([...memory.files.keys()]).toEqual([tomlPath]);
    expect(Object.fromEntries((await loadConfig(root, memory.fs)).explicit)).toEqual({
      "complexity.enabled": false,
      processGuide: false,
    });
  });

  it("keeps a valid TOML with --prefer toml when the JSON is malformed", async () => {
    const memory = memoryFs({ [jsonPath]: "{not json", [tomlPath]: TOML_SETTINGS });
    const error = (await convertConfig(target, { fs: memory.fs, token }).catch(
      (caught: unknown) => caught,
    )) as ConfigError;
    expect(error.code).toBe("duplicate-config");
    expect(error.recovery).toContain("pdb config convert --prefer toml");
    expect(await convertConfig(target, { fs: memory.fs, token, prefer: "toml" })).toMatchObject({
      status: "removed-json",
      wroteToml: false,
    });
    expect([...memory.files]).toEqual([[tomlPath, TOML_SETTINGS]]);
  });

  it("still refuses to discard a preferred-against file that changed since it was read", async () => {
    const memory = memoryFs({ [jsonPath]: "{not json", [tomlPath]: TOML_SETTINGS });
    memory.hooks.afterRead = (file) => {
      if (file === jsonPath && memory.files.get(jsonPath) === "{not json") {
        memory.files.set(jsonPath, "{still not json");
      }
    };
    await expect(
      convertConfig(target, { fs: memory.fs, token, prefer: "toml" }),
    ).rejects.toMatchObject({ code: "partial-conversion" });
    expect(memory.files.get(jsonPath)).toBe("{still not json");
    const invalidToml = memoryFs({ [jsonPath]: JSON_SETTINGS, [tomlPath]: "schemaVersion = \n" });
    invalidToml.hooks.beforeRename = () => invalidToml.files.set(tomlPath, "schemaVersion = 9\n");
    await expect(
      convertConfig(target, { fs: invalidToml.fs, token, prefer: "json" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(invalidToml.files.get(jsonPath)).toBe(JSON_SETTINGS);
    expect(invalidToml.files.get(tomlPath)).toBe("schemaVersion = 9\n");
  });

  it("resolves disagreeing files only with an explicit --prefer", async () => {
    const keepJson = memoryFs({
      [jsonPath]: '{"schemaVersion":1,"processGuide":true}',
      [tomlPath]: TOML_SETTINGS,
    });
    expect(await convertConfig(target, { fs: keepJson.fs, token, prefer: "json" })).toMatchObject({
      status: "replaced-toml",
      wroteToml: true,
      removedJson: true,
    });
    expect(Object.fromEntries((await loadConfig(root, keepJson.fs)).explicit)).toEqual({
      processGuide: true,
    });
    const keepToml = memoryFs({
      [jsonPath]: '{"schemaVersion":1,"processGuide":true}',
      [tomlPath]: TOML_SETTINGS,
    });
    expect(await convertConfig(target, { fs: keepToml.fs, token, prefer: "toml" })).toMatchObject({
      status: "removed-json",
      wroteToml: false,
    });
    expect(keepToml.files.get(tomlPath)).toBe(TOML_SETTINGS);
    expect(keepToml.files.has(jsonPath)).toBe(false);
  });

  it.each([
    ["malformed", "schemaVersion = \n"],
    ["malformed", "schemaVersion = 1.0\n"],
    ["unsupported-version", "schemaVersion = 2\n"],
    ["incompatible", 'schemaVersion = 1\nsecret = "x"\n'],
    ["incompatible", "schemaVersion = 1\nprocessGuide = 1\n"],
    ["incompatible", "schemaVersion = 1\nprocessGuide = 1979-05-27T07:32:00Z\n"],
    ["incompatible", 'schemaVersion = 1\n[complexity]\nenabled = "yes"\n'],
  ])("refuses %s TOML without rewriting it", async (code, raw) => {
    const memory = memoryFs({ [tomlPath]: raw });
    await expect(loadConfig(root, memory.fs)).rejects.toMatchObject({ code });
    await expect(
      updateConfig(target, new Map([["processGuide", true]]), { fs: memory.fs, token }),
    ).rejects.toMatchObject({ code });
    expect([...memory.files]).toEqual([[tomlPath, raw]]);
  });

  it("reports TOML syntax errors by position without echoing contents", async () => {
    const memory = memoryFs({ [tomlPath]: 'schemaVersion = 1\ntoken = "ghp_secret' });
    const error = (await loadConfig(root, memory.fs).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/line \d+, column \d+/);
    expect(error.message).not.toContain("ghp_secret");
  });

  it("refuses a concurrent TOML edit, and a JSON file appearing mid-write", async () => {
    const edited = memoryFs({ [tomlPath]: TOML_SETTINGS });
    edited.hooks.beforeRename = () => edited.files.set(tomlPath, "schemaVersion = 1\n");
    await expect(
      updateConfig(target, new Map([["processGuide", true]]), { fs: edited.fs, token }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(edited.files.get(tomlPath)).toBe("schemaVersion = 1\n");
    expect([...edited.files.keys()]).toEqual([tomlPath]);
    const appeared = memoryFs({ [tomlPath]: TOML_SETTINGS });
    appeared.hooks.beforeRename = () => appeared.files.set(jsonPath, '{"schemaVersion":1}');
    await expect(
      updateConfig(target, new Map([["processGuide", true]]), { fs: appeared.fs, token }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(appeared.files.get(tomlPath)).toBe(TOML_SETTINGS);
  });

  it("converts through the real filesystem in a temporary checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triage-convert-"));
    try {
      const local = { root: directory, repository: "owner/name" };
      await nodeFileSystem.makeDirectory(join(directory, ".github"));
      await nodeFileSystem.writeText(join(directory, LEGACY_CONFIG_PATH), JSON_SETTINGS);
      expect((await convertConfig(local)).status).toBe("converted");
      expect(await readdir(join(directory, ".github"))).toEqual(["triage.toml"]);
      expect(settingFor(await loadConfig(directory), "processGuide").value).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("config convert and storage reporting commands", () => {
    function setup(initial: Record<string, string> = {}) {
      const memory = memoryFs(initial);
      const git: GitRunner = async (args) =>
        args[0] === "rev-parse"
          ? `${root}\n`
          : args[0] === "remote"
            ? "origin\thttps://github.com/owner/name.git (fetch)\n"
            : "";
      const out: string[] = [];
      const call = (...args: string[]) =>
        main(["config", ...args, "--no-update-check"], async (t) => void out.push(t), {
          collect: async () => {
            throw new Error("no GitHub");
          },
          currentRepository: async () => {
            throw new Error("no GitHub");
          },
          config: { fs: memory.fs, git, cwd: root, env: {} },
        });
      return { ...memory, out, call, json: () => JSON.parse(out.at(-1)!) };
    }

    it("lists an unconverted JSON store with the convert command and never converts", async () => {
      const t = setup({ [jsonPath]: JSON_SETTINGS });
      expect(await t.call("list", "--json")).toBe(0);
      expect(t.json()).toMatchObject({
        path: jsonPath,
        storage: {
          format: "json",
          path: LEGACY_CONFIG_PATH,
          legacy: true,
          next: "pdb config convert",
        },
      });
      expect(await t.call("get", "processGuide")).toBe(0);
      expect(t.out.at(-1)).toContain("Note: .github/triage.json is the earlier JSON format");
      expect([...t.files]).toEqual([[jsonPath, JSON_SETTINGS]]);
    });

    it("converts with text and JSON output", async () => {
      const t = setup({ [jsonPath]: JSON_SETTINGS });
      expect(await t.call("convert", "--json")).toBe(0);
      expect(t.json()).toMatchObject({
        schemaVersion: 1,
        kind: "config-convert",
        status: "converted",
        path: tomlPath,
        storage: { format: "toml", legacy: false, next: null },
        droppedRetired: ["complexity.fieldId"],
      });
      expect(await t.call("convert")).toBe(0);
      expect(t.out.at(-1)).toContain("Already converted");
      expect(await t.call("get", "processGuide", "--json")).toBe(0);
      expect(t.json()).toMatchObject({ value: false, source: "explicit", path: tomlPath });
    });

    it("reports both files as a JSON error with exact commands, exit 1", async () => {
      const t = setup({ [jsonPath]: '{"schemaVersion":1}', [tomlPath]: TOML_SETTINGS });
      expect(await t.call("list", "--json")).toBe(1);
      expect(t.json()).toMatchObject({ kind: "config-error", code: "duplicate-config" });
      expect(await t.call("convert", "--prefer", "toml", "--json")).toBe(0);
      expect(t.json()).toMatchObject({ status: "removed-json" });
    });

    it("validates convert arguments and documents convert in help", async () => {
      const t = setup();
      expect(await t.call("get", "processGuide", "--prefer", "toml", "--json")).toBe(1);
      expect(t.json()).toMatchObject({ code: "usage" });
      expect(await t.call("convert", "--prefer", "yaml", "--json")).toBe(1);
      expect(t.json()).toMatchObject({ code: "usage" });
      expect(await t.call("help", "--json")).toBe(0);
      expect(t.json()).toMatchObject({
        path: TOML_CONFIG_PATH,
        legacyPath: LEGACY_CONFIG_PATH,
        convert: "pdb config convert",
      });
      expect(await t.call("help")).toBe(0);
      expect(t.out.at(-1)).toContain("config convert [--prefer toml|json]");
    });
  });
});

describe("config get/set/list/help commands (#117)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  function setup(
    initial?: string,
    remotes = "origin\thttps://github.com/owner/name.git (fetch)\n",
  ) {
    const files = new Map<string, string>(initial === undefined ? [] : [[path, initial]]);
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, text) => void files.set(file, text),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (file) => void files.delete(file),
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : args[0] === "remote" ? remotes : "";
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["config", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        config: { fs, git, cwd: root, env: {} },
      });
    return { files, fs, out, call, json: () => JSON.parse(out.at(-1)!) };
  }

  it("gets effective defaults with provenance without creating the file", async () => {
    const t = setup();
    expect(await t.call("get", "complexity.enabled")).toBe(0);
    expect(t.out[0]).toBe("complexity.enabled = true (default)\n");
    expect(await t.call("get", "processGuide", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      schemaVersion: 1,
      kind: "config-get",
      repository: "owner/name",
      key: "processGuide",
      value: false,
      source: "default",
    });
    expect(t.files.size).toBe(0);
  });

  it("lists a retired field mapping as ignored, and any set removes it (#153)", async () => {
    const t = setup('{"schemaVersion":1,"complexity":{"fieldId":"PVTF_1"}}');
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json().retired).toEqual([
      expect.objectContaining({
        key: "complexity.fieldId",
        next: "pdb config set complexity.enabled true",
      }),
    ]);
    expect(await t.call("list")).toBe(0);
    expect(t.out.at(-1)).toContain(
      "Ignored: .github/triage.json contains the retired key complexity.fieldId",
    );
    expect(await t.call("get", "complexity.fieldId", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unknown-key" });
    expect(await t.call("set", "complexity.enabled", "true")).toBe(0);
    expect(JSON.parse(t.files.get(path)!)).toEqual({
      schemaVersion: 1,
      complexity: { enabled: true },
    });
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json().retired).toEqual([]);
  });

  it("sets through the service, is idempotent, and disabling keeps other settings", async () => {
    const t = setup('{"schemaVersion":1,"processGuide":false}');
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ changed: true, value: false, source: "explicit" });
    const written = JSON.parse(t.files.get(path)!);
    expect(written).toEqual({
      schemaVersion: 1,
      complexity: { enabled: false },
      processGuide: false,
    });
    expect(await t.call("set", "complexity.enabled", "false")).toBe(0);
    expect(t.out.at(-1)).toContain("unchanged");
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json().settings).toEqual([
      expect.objectContaining({ key: "briefing.engine", value: "datalog", source: "default" }),
      expect.objectContaining({ key: "complexity.enabled", value: false, source: "explicit" }),
      expect.objectContaining({ key: "impact.enabled", value: true, source: "default" }),
      expect.objectContaining({ key: "review.policy", value: null, source: "default" }),
      expect.objectContaining({ key: "processGuide", value: false, source: "explicit" }),
    ]);
    expect(await t.call("list")).toBe(0);
    expect(t.out.at(-1)).toContain("processGuide = false (explicit)");
  });

  it("refuses bad keys, values, scopes and syntax with recovery, as JSON or text", async () => {
    const t = setup();
    expect(await t.call("set", "complexity.enabled", "nope", "--json")).toBe(1);
    expect(t.json()).toMatchObject({
      kind: "config-error",
      code: "invalid-value",
      recovery: "pdb config set complexity.enabled true|false",
    });
    expect(await t.call("get", "colour", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unknown-key" });
    expect(t.json().recovery).toContain("complexity.enabled");
    expect(await t.call("list", "--global", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unsupported-scope" });
    await expect(t.call("set", "complexity.enabled")).rejects.toThrow(/Usage: pdb config/);
    await expect(t.call("frobnicate")).rejects.toThrow(/Unknown config command/);
    expect(t.files.size).toBe(0);
  });

  it("reports filesystem failures as structured refusals but still propagates programming errors", async () => {
    const t = setup();
    const denied = (op: string) =>
      Object.assign(new Error(`${op} denied`), { code: "EACCES", path });
    t.fs.readText = async () => {
      throw denied("open");
    };
    expect(await t.call("list", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ kind: "config-error", code: "filesystem" });
    expect(t.json().message).toContain("EACCES");
    await expect(t.call("get", "complexity.enabled")).rejects.toThrow(
      /EACCES[\s\S]*Nothing was changed/,
    );
    t.fs.readText = async () => null;
    t.fs.writeText = async () => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    };
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "filesystem" });
    t.fs.writeText = async () => {
      throw new TypeError("bug");
    };
    await expect(t.call("set", "complexity.enabled", "false", "--json")).rejects.toThrow("bug");
  });

  it("refuses a repository that does not match the checkout and malformed files untouched", async () => {
    const t = setup("{oops");
    expect(
      await t.call("set", "complexity.enabled", "false", "--repo", "other/repo", "--json"),
    ).toBe(1);
    expect(t.json()).toMatchObject({ code: "repository-mismatch" });
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "malformed" });
    expect(t.files.get(path)).toBe("{oops");
  });

  it("explains keys, defaults and valid values in text and JSON help", async () => {
    const t = setup();
    expect(await t.call("help")).toBe(0);
    expect(t.out[0]).toContain("complexity.enabled (boolean; default true; valid: true, false)");
    expect(await t.call("help", "processGuide", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      kind: "config-help",
      keys: [{ key: "processGuide", defaultValue: false }],
    });
    expect(t.out.join("")).not.toContain("fieldId");
    expect(await t.call("--help")).toBe(0);
    const top: string[] = [];
    await main(["--help", "--no-update-check"], async (x) => void top.push(x));
    expect(top.join("")).toContain("config get KEY | set KEY VALUE | list | convert | help [KEY]");
  });
});
