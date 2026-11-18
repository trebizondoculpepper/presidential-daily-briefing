/**
 * PDB serve application state (#816, doc/design/serve-application-state.md): the running
 * process's startup and applied global-configuration snapshots, compared with the last saved
 * snapshot to report live versus restart consequences with named reasons.
 *
 * In memory only, never persisted. It makes no reads or writes: callers pass in the snapshots
 * the configuration service (#804) loaded, so it is pure apart from the injected clock.
 */

import { createHash } from "node:crypto";
import { GLOBAL_KEYS, globalChanges } from "../config/globalconfig.js";
import type { GlobalConfigError, GlobalValue, LoadedGlobalConfig } from "../config/globalconfig.js";

/** A file-content digest, or "absent" when there is no config.toml (valid defaults). */
export type Revision = string;

export type Applies = "live" | "restart";

/**
 * What a change to each global key means for the running process. One registry beside
 * GLOBAL_KEYS: a key without an entry is restart-only, never assumed live.
 */
export const KEY_CONSEQUENCES: Readonly<Record<string, { applies: Applies; reason: string }>> = {
  "serve.port": { applies: "restart", reason: "The listening port is bound at startup." },
  "serve.ttl": {
    applies: "restart",
    reason: "Cache lifetime is fixed when the cache is created.",
  },
  "serve.projects": {
    applies: "live",
    reason: "Registered projects are applied by reload.",
  },
};
const UNDECLARED = { applies: "restart" as const, reason: "Consequence not declared." };
const consequenceOf = (key: string) => KEY_CONSEQUENCES[key] ?? UNDECLARED;

export type KeyState =
  | { status: "in-sync" }
  | { status: "pending-live"; reason: string }
  | { status: "failed-live"; reason: string; error: string }
  | { status: "restart-required"; reason: string }
  | { status: "overridden"; source: string };

export interface KeyView {
  key: string;
  applies: Applies;
  startup: GlobalValue;
  applied: GlobalValue;
  /** null when the saved configuration is unreadable or invalid. */
  saved: GlobalValue | null;
  state: KeyState;
}

export interface ApplicationStateView {
  schemaVersion: 1;
  startedAt: string;
  /** null only when the saved configuration is unreadable or invalid. */
  savedRevision: Revision | null;
  appliedRevision: Revision;
  keys: KeyView[];
  restartRequired: string[];
  pendingLive: string[];
  readError: { code: string; message: string } | null;
}

export interface ApplicationResult {
  revision: Revision;
  applied: string[];
  failed: { key: string; error: string }[];
}

export interface ApplicationState {
  view(): ApplicationStateView;
  observe(saved: LoadedGlobalConfig | { error: GlobalConfigError }): ApplicationStateView;
  recordApplication(result: ApplicationResult): ApplicationStateView;
}

/** The revision of a loaded snapshot: a digest of its raw text, or "absent" with no file. */
export function revisionOf(loaded: Pick<LoadedGlobalConfig, "raw">): Revision {
  return loaded.raw === null
    ? "absent"
    : `sha256:${createHash("sha256").update(loaded.raw).digest("hex")}`;
}

/** Effective values (explicit or default) for every registered key. */
function effective(loaded: LoadedGlobalConfig): Map<string, GlobalValue> {
  return new Map(loaded.settings.map((s) => [s.key, s.value]));
}

const same = (a: GlobalValue | undefined, b: GlobalValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createApplicationState(
  startup: LoadedGlobalConfig,
  overrides: ReadonlyMap<string, GlobalValue>,
  clock: () => Date,
): ApplicationState {
  const startedAt = clock().toISOString();
  const startupValues = effective(startup);
  for (const [key, value] of overrides) startupValues.set(key, value);
  const applied = new Map(startupValues);
  let appliedRevision: Revision = revisionOf(startup);
  let saved: { values: Map<string, GlobalValue>; revision: Revision } | null = {
    values: effective(startup),
    revision: appliedRevision,
  };
  let readError: ApplicationStateView["readError"] = null;
  // Live keys whose application of the current saved revision failed, with the error.
  const failures = new Map<string, string>();

  const keys = (): string[] => [...new Set([...GLOBAL_KEYS.map((k) => k.key), ...applied.keys()])];

  const view = (): ApplicationStateView => {
    // The shared comparison: which keys' saved values differ from what is applied.
    const differing = new Set(saved ? globalChanges(applied, saved.values).map((c) => c.key) : []);
    const rows: KeyView[] = keys().map((key) => {
      const { applies, reason } = consequenceOf(key);
      const savedValue = saved ? (saved.values.get(key) ?? null) : null;
      let state: KeyState;
      if (overrides.has(key)) state = { status: "overridden", source: "command-line override" };
      else if (!saved || !differing.has(key)) state = { status: "in-sync" };
      else if (applies === "restart") state = { status: "restart-required", reason };
      else if (failures.has(key))
        state = { status: "failed-live", reason, error: failures.get(key)! };
      else state = { status: "pending-live", reason };
      return {
        key,
        applies,
        startup: startupValues.get(key)!,
        applied: applied.get(key)!,
        saved: savedValue,
        state,
      };
    });
    return {
      schemaVersion: 1,
      startedAt,
      savedRevision: saved ? saved.revision : null,
      appliedRevision,
      keys: rows,
      restartRequired: rows.filter((r) => r.state.status === "restart-required").map((r) => r.key),
      pendingLive: rows
        .filter((r) => r.state.status === "pending-live" || r.state.status === "failed-live")
        .map((r) => r.key),
      readError,
    };
  };

  return {
    view,
    observe(next) {
      if ("error" in next) {
        // Invalid or unreadable: keep the last valid applied values; report the error.
        saved = null;
        readError = { code: next.error.code, message: next.error.message };
        return view();
      }
      const revision = revisionOf(next);
      // A new revision starts its own application attempt; earlier failures no longer apply.
      if (!saved || saved.revision !== revision) failures.clear();
      saved = { values: effective(next), revision };
      readError = null;
      return view();
    },
    recordApplication(result) {
      // Only a report for the revision currently observed can advance anything.
      if (!saved || saved.revision !== result.revision) return view();
      for (const key of result.applied) {
        if (overrides.has(key) || consequenceOf(key).applies !== "live") continue;
        if (saved.values.has(key)) applied.set(key, saved.values.get(key)!);
        failures.delete(key);
      }
      for (const f of result.failed) failures.set(f.key, f.error);
      // The shared revision advances only once every differing live key is applied.
      const outstanding = keys().some(
        (key) =>
          !overrides.has(key) &&
          consequenceOf(key).applies === "live" &&
          !same(applied.get(key), saved!.values.get(key)),
      );
      if (!outstanding) appliedRevision = result.revision;
      return view();
    },
  };
}
