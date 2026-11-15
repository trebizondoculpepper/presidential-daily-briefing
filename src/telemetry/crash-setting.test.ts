import { mkdtemp, realpath, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  crashesEnabled,
  crashConfigPath,
  crashDisclosure,
  readCrashConfigFile,
} from "./crash-setting.js";

describe("process-wide crash configuration", () => {
  it("defaults on only when configuration is absent or valid", async () => {
    for (const text of [null, "", "[telemetry.crashes]\nenabled=true", "[telemetry.crashes]"])
      expect(await crashesEnabled(async () => text)).toBe(true);
  });
  it("fails closed for opt-out, unreadable or invalid settings", async () => {
    for (const text of [
      "[telemetry.crashes]\nenabled=false",
      "[telemetry.crashes]\nenabled='true'",
      "[telemetry.crashes]\nenabled=1",
      "[telemetry.crashes]\nunknown=true",
      "unknown=true",
      "telemetry=false",
      "[invalid",
      "#".repeat(65537),
    ])
      expect(await crashesEnabled(async () => text), text.slice(0, 80)).toBe(false);
    expect(
      await crashesEnabled(async () => {
        throw new Error("private path");
      }),
    ).toBe(false);
  });
  it("reads only bounded regular configuration files", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "pdb-crash-config-")));
    try {
      const file = join(dir, "crash-reporting.toml");
      expect(await readCrashConfigFile(file)).toBe(null);
      await writeFile(file, "[telemetry.crashes]\nenabled=false");
      expect(await crashesEnabled(() => readCrashConfigFile(file))).toBe(false);
      await writeFile(file, "#".repeat(65537));
      expect(await crashesEnabled(() => readCrashConfigFile(file))).toBe(false);
      expect(await crashesEnabled(() => readCrashConfigFile(dir))).toBe(false);
      if (process.platform !== "win32") {
        await symlink(file, join(dir, "link.toml"));
        expect(await crashesEnabled(() => readCrashConfigFile(join(dir, "link.toml")))).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("documents the actual process-wide path and immediate opt-out", () => {
    expect(crashDisclosure()).toContain(crashConfigPath());
    expect(crashDisclosure()).toContain("SENTRY_DISABLED=1");
  });
});
