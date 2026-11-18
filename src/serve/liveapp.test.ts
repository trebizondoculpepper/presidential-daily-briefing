import { describe, expect, it } from "vite-plus/test";
import {
  applyLiveApplication,
  entriesFromSaved,
  reconcileContexts,
  type LiveApplicationBoundaries,
  type ServedEntry,
} from "./liveapp.js";
import type { LoadedGlobalConfig } from "../config/globalconfig.js";

function savedConfig(
  projects: unknown,
  raw = JSON.stringify({ schemaVersion: 1, serve: { projects } }),
): LoadedGlobalConfig {
  return {
    format: "toml",
    path: "config.toml",
    storedVersion: 1,
    explicit: new Map<string, unknown>([["serve.projects", projects]]),
    settings: [],
    raw,
    retired: [],
  } as LoadedGlobalConfig;
}

function boundaries(overrides: {
  current?: ServedEntry[];
  invalidated?: string[];
  recorded?: { applied: string[]; failed: { key: string; error: string }[] }[];
}) {
  const current = overrides.current ?? [];
  const invalidated: string[] = [];
  const recorded: {
    revision: string;
    applied: string[];
    failed: { key: string; error: string }[];
  }[] = [];
  const b: LiveApplicationBoundaries = {
    currentServed: () => current,
    invalidate: (repository) => {
      invalidated.push(repository.toLowerCase());
      return 0;
    },
    record: (r) => {
      recorded.push(r);
      return {} as never;
    },
  };
  return { b, invalidated, recorded };
}

describe("live application with request-context isolation (#808)", () => {
  it("serves the saved registrations only: added contexts invalidate nothing; changed/removed invalidate the cache", async () => {
    const { b, invalidated, recorded } = boundaries({
      current: [{ repository: "a/b", project: "/a" }, { repository: "c/d" }],
    });
    const result = await applyLiveApplication(
      savedConfig([
        { host: "github.com", repository: "a/b", localRoot: "/a" },
        { host: "github.com", repository: "e/f" },
      ]),
      b,
    );
    // a/b unchanged, c/d removed, e/f added.
    expect(result.changes).toEqual([
      { repository: "a/b", change: "unchanged" },
      { repository: "e/f", change: "added" },
      { repository: "c/d", change: "removed" },
    ]);
    // Only the removed context is invalidated; a/b (unchanged) and e/f (added) are not.
    expect(invalidated).toEqual(["c/d"]);
    expect(recorded).toEqual([
      { revision: expect.any(String), applied: ["serve.projects"], failed: [] },
    ]);
  });

  it("invalidates a changed context (same repository, different verified root) and reports A->B->A consistently", async () => {
    let served: ServedEntry[] = [{ repository: "a/b", project: "/a" }];
    const invalidated: string[] = [];
    const b: LiveApplicationBoundaries = {
      currentServed: () => served,
      invalidate: (repository) => {
        invalidated.push(repository.toLowerCase());
        return 0;
      },
      record: () => ({}) as never,
    };
    // Change a/b's root: /a -> /b.
    const first = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "a/b", localRoot: "/b" }]),
      b,
    );
    expect(first.changes).toEqual([{ repository: "a/b", change: "changed", project: "/b" }]);
    expect(invalidated).toEqual(["a/b"]);
    served = [{ repository: "a/b", project: "/b" }];
    // Revert /b -> /a: again a change (there is no stale-old-epoch resurrection).
    const second = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "a/b", localRoot: "/a" }]),
      b,
    );
    expect(second.changes).toEqual([{ repository: "a/b", change: "changed", project: "/a" }]);
    expect(invalidated).toEqual(["a/b", "a/b"]);
  });

  it("treats a no-op reload as applied-none and does not invalidate", async () => {
    const { b, invalidated, recorded } = boundaries({
      current: [{ repository: "a/b", project: "/a" }],
    });
    const result = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "a/b", localRoot: "/a" }]),
      b,
    );
    expect(result.changes).toEqual([{ repository: "a/b", change: "unchanged" }]);
    expect(invalidated).toEqual([]);
    expect(recorded[0]!.applied).toEqual([]);
    expect(recorded[0]!.failed).toEqual([]);
  });

  it("reports diagnostics for a registered host this build cannot serve, keeping it saved", async () => {
    const { b, invalidated } = boundaries({ current: [] });
    const result = await applyLiveApplication(
      savedConfig([
        { host: "ghe.example.com", repository: "a/b" },
        { host: "github.com", repository: "c/d" },
      ]),
      b,
    );
    expect(result.served).toEqual([{ repository: "c/d" }]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("ghe.example.com");
    expect(invalidated).toEqual([]);
  });

  it("derives membership from the saved registrations only, never the current served superset", async () => {
    // The running set is a superset (startup inputs) that a removal must be able to drop.
    const { b, invalidated } = boundaries({
      current: [{ repository: "cwd/repo", project: "/cwd" }, { repository: "a/b" }],
    });
    const result = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "a/b" }]),
      b,
    );
    // cwd/repo is not in the saved set, so it is removed, not re-added from startup context.
    expect(result.changes).toContainEqual({ repository: "cwd/repo", change: "removed" });
    expect(invalidated).toContain("cwd/repo");
  });

  it("projects the saved set with entriesFromSaved (pure)", () => {
    expect(entriesFromSaved([{ host: "github.com", repository: "a/b", localRoot: "/a" }])).toEqual({
      served: [{ repository: "a/b", project: "/a" }],
      diagnostics: [],
    });
    expect(entriesFromSaved([{ host: "ghe.example.com", repository: "a/b" }]).served).toEqual([]);
  });

  it("acknowledges a value change even when no individual context changed (reorder, case-only)", async () => {
    // The saved list is reordered; every entry maps to an unchanged context, but the saved
    // *value* (order, spelling) differs, so #816 must not stay pending-live forever.
    const { b, recorded } = boundaries({
      current: [{ repository: "Owner/Repo" }, { repository: "a/b" }],
    });
    await applyLiveApplication(
      savedConfig([
        { host: "github.com", repository: "a/b" },
        { host: "github.com", repository: "Owner/Repo" },
      ]),
      b,
    );
    expect(recorded[0]!.applied).toEqual(["serve.projects"]);
    expect(recorded[0]!.failed).toEqual([]);
  });

  it("invalidates cross-repository dependency trees when a context is changed or removed", async () => {
    let served: ServedEntry[] = [{ repository: "a/b" }, { repository: "c/d" }];
    const deps: string[] = [];
    const b: LiveApplicationBoundaries = {
      currentServed: () => served,
      invalidate: () => 0,
      invalidateDependencies: (repository) => {
        deps.push(repository.toLowerCase());
        return 0;
      },
      record: () => ({}) as never,
    };
    await applyLiveApplication(savedConfig([{ host: "github.com", repository: "a/b" }]), b);
    // c/d removed: a/b's cached dependency tree is invalidated conservatively (it may reference
    // c/d).
    expect(deps).toEqual(["a/b"]);
    // No change means no conservative cross-repo refresh.
    served = [{ repository: "a/b" }, { repository: "c/d" }];
    const deps2: string[] = [];
    await applyLiveApplication(
      savedConfig([
        { host: "github.com", repository: "a/b" },
        { host: "github.com", repository: "c/d" },
      ]),
      { ...b, invalidateDependencies: (repository) => (deps2.push(repository.toLowerCase()), 0) },
    );
    expect(deps2).toEqual([]);
  });

  it("verifies saved roots before serving them, falling back to repo-only on a moved checkout", async () => {
    const { b } = boundaries({ current: [] });
    const result = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "owner/a", localRoot: "/work/moved" }]),
      {
        ...b,
        // The saved root now belongs to owner/b (reused registration boundary).
        verifyProject: async (repository, _localRoot) => ({
          project: undefined,
          diagnostic: `saved project is now owner/b, not ${repository}; serving repo-only.`,
        }),
      },
    );
    expect(result.served).toEqual([{ repository: "owner/a" }]);
    expect(result.diagnostics.join("\n")).toMatch(/owner\/b, not owner\/a/);

    // A root that still verifies is served as saved.
    const ok = await applyLiveApplication(
      savedConfig([{ host: "github.com", repository: "owner/a", localRoot: "/work/a" }]),
      {
        ...b,
        verifyProject: async (_repository, localRoot) => ({ project: localRoot }),
      },
    );
    expect(ok.served).toEqual([{ repository: "owner/a", project: "/work/a" }]);
    expect(ok.diagnostics).toEqual([]);
  });

  it("deduplicates saved registrations by canonical repository before reconciling", async () => {
    const { b, invalidated } = boundaries({ current: [] });
    // Same repository twice: first repo-only, then with a verified root — refined once.
    const result = await applyLiveApplication(
      savedConfig([
        { host: "github.com", repository: "Owner/Repo" },
        { host: "github.com", repository: "owner/repo", localRoot: "/work/repo" },
      ]),
      b,
    );
    expect(result.served).toEqual([{ repository: "Owner/Repo", project: "/work/repo" }]);
    expect(result.changes).toEqual([{ repository: "Owner/Repo", change: "added" }]);

    // Two different roots for the same repository are a configuration error.
    await expect(
      applyLiveApplication(
        savedConfig([
          { host: "github.com", repository: "owner/repo", localRoot: "/work/one" },
          { host: "github.com", repository: "owner/repo", localRoot: "/work/two" },
        ]),
        b,
      ),
    ).rejects.toThrow(/two saved local projects/);
    // Nothing was invalidated by a rejected dedupe.
    expect(invalidated).toEqual([]);
  });

  it("reconcileContexts is pure and order-preserving", () => {
    const current: ServedEntry[] = [{ repository: "a/b" }, { repository: "z/y" }];
    const target: ServedEntry[] = [
      { repository: "a/b" },
      { repository: "m/n" },
      { repository: "q/r", project: "/q" },
    ];
    expect(reconcileContexts(current, target)).toEqual([
      { repository: "a/b", change: "unchanged" },
      { repository: "m/n", change: "added" },
      { repository: "q/r", change: "added" },
      { repository: "z/y", change: "removed" },
    ]);
  });
});
