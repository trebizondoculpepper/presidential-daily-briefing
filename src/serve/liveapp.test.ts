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
