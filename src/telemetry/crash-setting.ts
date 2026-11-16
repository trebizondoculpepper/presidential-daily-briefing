/** Process-wide user consent; never resolved from repository or MCP caller content. */
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import envPaths from "env-paths";
import { parse } from "smol-toml";

export const crashConfigPath = () =>
  join(envPaths("presidential-daily-briefing").config, "crash-reporting.toml");
export type CrashConfigReader = () => Promise<string | null>;
const maxBytes = 64 * 1024;

export async function readCrashConfigFile(file: string): Promise<string | null> {
  try {
    for (let path = file; ; path = dirname(path)) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Unsafe crash configuration path");
      if (path === file && (!info.isFile() || info.size > maxBytes))
        throw new Error("Invalid crash configuration file");
      if (dirname(path) === path) break;
    }
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > maxBytes) throw new Error("Oversized crash configuration");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export const readCrashConfig: CrashConfigReader = () => readCrashConfigFile(crashConfigPath());
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: unknown, key: string): value is Record<string, unknown> =>
  object(value) && Object.keys(value).every((k) => k === key);
/** Invalid/unreadable configuration disables telemetry without breaking the command. */
export async function crashesEnabled(read: CrashConfigReader = readCrashConfig): Promise<boolean> {
  try {
    const raw = await read();
    if (raw === null) return true;
    if (Buffer.byteLength(raw) > maxBytes) return false;
    const config = parse(raw);
    if (!only(config, "telemetry")) return false;
    if (config.telemetry === undefined) return true;
    if (!only(config.telemetry, "crashes")) return false;
    if (config.telemetry.crashes === undefined) return true;
    if (!only(config.telemetry.crashes, "enabled")) return false;
    const enabled = config.telemetry.crashes.enabled;
    return enabled === undefined || enabled === true;
  } catch {
    return false;
  }
}
export const crashDisclosure =
  () => `Unhandled crash reporting is on by default (fixed error text, public PDB stack locations, mode/version; the receiving service sees network metadata).
Disable immediately: SENTRY_DISABLED=1
Or set [telemetry.crashes] enabled = false in ${crashConfigPath()} and restart PDB.`;
