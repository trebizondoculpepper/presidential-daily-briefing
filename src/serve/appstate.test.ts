import { describe, expect, it } from "vite-plus/test";
import { createApplicationState, KEY_CONSEQUENCES, revisionOf } from "./appstate.js";
import { GLOBAL_KEYS, GlobalConfigError } from "../config/globalconfig.js";
import type { GlobalValue, LoadedGlobalConfig } from "../config/globalconfig.js";

// Synthetic configuration snapshots only; no filesystem.
const clock = () => new Date("2026-11-18T00:00:00.000Z");
const project = (repository: string) => ({ host: "github.com", repository });
function loaded(explicit: Record<string, GlobalValue> | null): LoadedGlobalConfig {
  const map = new Map(Object.entries(explicit ?? {}));
  return {
    path: "/synthetic/config.toml",
    storedVersion: explicit ? 1 : null,
    explicit: map,
    settings: GLOBAL_KEYS.map((k) => ({
      key: k.key,
      value: map.has(k.key) ? map.get(k.key)! : k.defaultValue,
      source: map.has(k.key) ? ("explicit" as const) : ("default" as const),
    })),
    // The revision is a digest of the text, so any distinct text gives a distinct revision.
    raw: explicit ? JSON.stringify(explicit) : null,
  };
}
const stateOf = (v: ReturnType<ReturnType<typeof createApplicationState>["view"]>, key: string) =>
  v.keys.find((k) => k.key === key)!.state;

describe("serve application state (#816)", () => {
  it("declares a consequence for every registered key", () => {
    for (const k of GLOBAL_KEYS) expect(KEY_CONSEQUENCES[k.key], k.key).toBeDefined();
  });

  it("rule 1: starts in sync at the startup revision", () => {
    const start = loaded({ "serve.port": 4372 });
    const v = createApplicationState(start, new Map(), clock).view();
    expect(v.keys.every((k) => k.state.status === "in-sync")).toBe(true);
    expect(v.appliedRevision).toBe(revisionOf(start));
    expect(v).toMatchObject({ restartRequired: [], pendingLive: [], readError: null });
  });

  it("rule 2: a restart key differing from the running value needs a restart until reverted", () => {
    const s = createApplicationState(loaded({ "serve.port": 4372 }), new Map(), clock);
    const changed = s.observe(loaded({ "serve.port": 5000 }));
    expect(stateOf(changed, "serve.port")).toMatchObject({ status: "restart-required" });
    expect(changed.restartRequired).toEqual(["serve.port"]);
    const reverted = s.observe(loaded({ "serve.port": 4372 }));
    expect(stateOf(reverted, "serve.port")).toEqual({ status: "in-sync" });
    expect(reverted.restartRequired).toEqual([]);
  });

  it("rule 3: a live change is pending until applied; failure never advances it", () => {
    const s = createApplicationState(loaded(null), new Map(), clock);
    const next = loaded({ "serve.projects": [project("o/a")] });
    expect(stateOf(s.observe(next), "serve.projects")).toMatchObject({ status: "pending-live" });
    const failed = s.recordApplication({
      revision: revisionOf(next),
      applied: [],
      failed: [{ key: "serve.projects", error: "checkout not found" }],
    });
    expect(stateOf(failed, "serve.projects")).toMatchObject({
      status: "failed-live",
      error: "checkout not found",
    });
    expect(failed.appliedRevision).toBe("absent");
    const ok = s.recordApplication({
      revision: revisionOf(next),
      applied: ["serve.projects"],
      failed: [],
    });
    expect(stateOf(ok, "serve.projects")).toEqual({ status: "in-sync" });
    expect(ok.appliedRevision).toBe(revisionOf(next));
  });

  it("rule 4: re-observing the applied revision with nothing outstanding changes nothing", () => {
    const start = loaded({ "serve.port": 4372 });
    const s = createApplicationState(start, new Map(), clock);
    expect(s.observe(start)).toEqual(s.view());
    expect(s.view()).toMatchObject({ restartRequired: [], pendingLive: [] });
  });

  it("rule 5: a partial application leaves the revision retryable", () => {
    // Two live keys would be needed for a true split; an undeclared extra key is restart-only,
    // so model partial application as one report applying nothing and failing nothing.
    const s = createApplicationState(loaded(null), new Map(), clock);
    const next = loaded({ "serve.projects": [project("o/a")] });
    s.observe(next);
    const partial = s.recordApplication({ revision: revisionOf(next), applied: [], failed: [] });
    expect(partial.appliedRevision).toBe("absent");
    expect(stateOf(partial, "serve.projects")).toMatchObject({ status: "pending-live" });
    // Reloading the same unchanged file is not a no-op: it can be retried and succeed.
    s.observe(next);
    const retried = s.recordApplication({
      revision: revisionOf(next),
      applied: ["serve.projects"],
      failed: [],
    });
    expect(retried.appliedRevision).toBe(revisionOf(next));
  });

  it("rule 6: an unreadable saved config keeps the last applied values and reports the error", () => {
    const s = createApplicationState(loaded({ "serve.port": 4372 }), new Map(), clock);
    const v = s.observe({ error: new GlobalConfigError("malformed", "bad TOML", "fix it") });
    expect(v.readError).toEqual({ code: "malformed", message: "bad TOML" });
    expect(v.savedRevision).toBeNull();
    expect(v.keys.every((k) => k.saved === null)).toBe(true);
    expect(v.keys.find((k) => k.key === "serve.port")!.applied).toBe(4372);
  });

  it("rule 7: a new process starts with fresh snapshots and no earlier notices", () => {
    const later = loaded({ "serve.port": 5000 });
    const fresh = createApplicationState(later, new Map(), clock).view();
    expect(fresh.restartRequired).toEqual([]);
  });

  it("rule 8: an overridden key never produces a restart notice", () => {
    const s = createApplicationState(
      loaded({ "serve.port": 4372 }),
      new Map([["serve.port", 9000]]),
      clock,
    );
    const start = s.observe(loaded({ "serve.port": 4372 }));
    expect(stateOf(start, "serve.port")).toMatchObject({ status: "overridden" });
    expect(start.keys.find((k) => k.key === "serve.port")!.applied).toBe(9000);
    const saved = s.observe(loaded({ "serve.port": 5000 }));
    expect(stateOf(saved, "serve.port")).toMatchObject({ status: "overridden" });
    expect(saved.restartRequired).toEqual([]);
  });

  it("rule 9: a deleted file is the absent revision and can be applied or fail", () => {
    const start = loaded({ "serve.projects": [project("o/a")] });
    const ok = createApplicationState(start, new Map(), clock);
    const deleted = ok.observe(loaded(null));
    expect(deleted.savedRevision).toBe("absent");
    expect(stateOf(deleted, "serve.projects")).toMatchObject({ status: "pending-live" });
    const applied = ok.recordApplication({
      revision: "absent",
      applied: ["serve.projects"],
      failed: [],
    });
    expect(applied).toMatchObject({ appliedRevision: "absent", pendingLive: [] });

    const bad = createApplicationState(start, new Map(), clock);
    bad.observe(loaded(null));
    const failed = bad.recordApplication({
      revision: "absent",
      applied: [],
      failed: [{ key: "serve.projects", error: "busy" }],
    });
    expect(stateOf(failed, "serve.projects")).toMatchObject({ status: "failed-live" });
    expect(failed.appliedRevision).toBe(revisionOf(start));
  });

  it("ignores an application report for a revision that is no longer the saved one", () => {
    const s = createApplicationState(loaded(null), new Map(), clock);
    const first = loaded({ "serve.projects": [project("o/a")] });
    s.observe(first);
    s.observe(loaded({ "serve.projects": [project("o/b")] }));
    const stale = s.recordApplication({
      revision: revisionOf(first),
      applied: ["serve.projects"],
      failed: [],
    });
    expect(stateOf(stale, "serve.projects")).toMatchObject({ status: "pending-live" });
    expect(stale.appliedRevision).toBe("absent");
  });

  it("never advances a restart key, even when reported as applied", () => {
    const s = createApplicationState(loaded({ "serve.port": 4372 }), new Map(), clock);
    const next = loaded({ "serve.port": 5000 });
    s.observe(next);
    const v = s.recordApplication({
      revision: revisionOf(next),
      applied: ["serve.port"],
      failed: [],
    });
    expect(stateOf(v, "serve.port")).toMatchObject({ status: "restart-required" });
    expect(v.keys.find((k) => k.key === "serve.port")!.applied).toBe(4372);
  });
});
