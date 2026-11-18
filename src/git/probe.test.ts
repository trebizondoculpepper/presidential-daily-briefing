import { describe, expect, it } from "vite-plus/test";
import { createProbeGitService } from "./probe.js";
import type { GitResult, GitRunner } from "./probe.js";

// Synthetic probe answers only; no Git is run.
const answers =
  (table: Record<string, GitResult>): GitRunner =>
  async (args) =>
    table[args.join(" ")] ?? { ok: false, reason: "failed", code: 128 };
const id = "a".repeat(40);
const other = "b".repeat(40);

describe("bounded offline probe facade (#940)", () => {
  const build = (runner: GitRunner, callBudget = 8) =>
    createProbeGitService({
      root: "/w",
      runner,
      callTimeoutMs: 1000,
      callBudget,
      deadlineMs: 3000,
      now: () => 0,
    });

  it("parses layout, head, refs, snapshots and divergence into typed answers", async () => {
    const svc = build(
      answers({
        "rev-parse --show-toplevel --git-dir --git-common-dir --is-shallow-repository": {
          ok: true,
          stdout: "/w\n.git\n.git\nfalse",
        },
        "symbolic-ref -q HEAD": { ok: true, stdout: "refs/heads/main" },
        remote: { ok: true, stdout: "origin" },
        [`show-ref --head refs/remotes/origin/main`]: {
          ok: true,
          stdout: `${id} HEAD\n${other} refs/remotes/origin/main`,
        },
        [`rev-list --left-right --count ${other}...${id}`]: { ok: true, stdout: "2\t1" },
      }),
    );
    expect(await svc.layout()).toEqual({
      toplevel: "/w",
      gitDir: ".git",
      commonDir: ".git",
      shallow: false,
    });
    expect(await svc.headRef()).toEqual({ ref: "refs/heads/main", detached: false });
    expect(await svc.remoteNames()).toEqual(["origin"]);
    expect(await svc.refSnapshot(["refs/remotes/origin/main"])).toEqual(
      new Map([
        ["HEAD", id],
        ["refs/remotes/origin/main", other],
      ]),
    );
    expect(await svc.divergence(other, id)).toEqual({ behind: 2, ahead: 1 });
  });

  it("proves detached and unborn only by exit 1, and rejects non-object IDs", async () => {
    const svc = build(
      answers({
        "symbolic-ref -q HEAD": { ok: false, reason: "failed", code: 1 },
        "rev-parse --verify -q HEAD^{commit}": { ok: false, reason: "failed", code: 1 },
      }),
    );
    expect(await svc.headRef()).toEqual({ ref: null, detached: true });
    expect(await svc.headCommit()).toEqual({ unborn: true });
    expect(await svc.divergence("HEAD", id)).toBeNull();
  });

  it("reports an exhausted budget as a timeout, never as an answer", async () => {
    let calls = 0;
    const svc = build(async () => {
      calls++;
      return { ok: true, stdout: "origin" };
    }, 1);
    expect(await svc.remoteNames()).toEqual(["origin"]);
    expect(await svc.remoteNames()).toBeNull();
    expect(svc.state.timedOut).toBe(true);
    expect(calls).toBe(1);
  });
});
