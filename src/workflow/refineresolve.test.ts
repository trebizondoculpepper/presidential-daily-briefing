/**
 * `pdb refine resolve` and `pdb refine status` (#1096): question IDs and their resolution
 * evidence, clearing only a satisfied request, truthful receipts on partial writes and concurrent
 * edits, and next-step guidance from the native policy. Injected GH boundary; no live writes.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import type { Query } from "../github/github.js";
import { decisionGuidance, denialText } from "../rules/datalog/engine.js";
import { refineResolveArgumentsFor, refineResolveUsage } from "./refinecli.js";
import { refinementLabel } from "./refinement.js";
import { world } from "../testing/refinementworld.js";
import { repo } from "../testing/snapshots.js";

const run = async (w: ReturnType<typeof world>, args: string[]) => {
  let text = "";
  const code = await main(["refine", ...args, "--repo", repo], async (t) => void (text = t), {
    collect: async () => {
      throw new Error("no briefing");
    },
    currentRepository: async () => repo,
    query: w.query as unknown as Query,
    ghRun: w.run,
    rest: w.rest,
  });
  return { code, text };
};
const request = (w: ReturnType<typeof world>, question = "Which engine?") =>
  run(w, [
    "request",
    "1",
    "--agent",
    "kavya",
    "--designer",
    "nicole",
    "--why",
    "Unclear.",
    "--question",
    question,
    "--json",
  ]).then((r) => JSON.parse(r.text).guidance.request as string);
const resolve = (w: ReturnType<typeof world>, op: string, extra: string[] = []) =>
  run(w, ["resolve", "1", "--agent", "nicole", "--request", op, "--why", "Answered.", ...extra]);
const status = async (w: ReturnType<typeof world>) => {
  const r = await run(w, ["status", "1", "--agent", "nicole", "--json"]);
  return { code: r.code, body: JSON.parse(r.text) };
};

describe("refine status (#1096)", () => {
  it("lists each request with its question ID and answer, without answering anything", async () => {
    const w = world();
    w.add(1);
    const op = await request(w);
    const listed = await status(w);
    expect(listed.code).toBe(0);
    expect(listed.body).toMatchObject({
      kind: "refinement-status",
      labelPresent: true,
      labelAgrees: true,
    });
    expect(listed.body.requests).toEqual([
      {
        request: op,
        question: `https://github.com/${repo}/issues/1#issuecomment-${w.questionOf(1)}`,
        outcome: "none",
        state: "open",
        resolvedBy: null,
        dependencies: [],
      },
    ]);
    const text = (await run(w, ["status", "1", "--agent", "nicole"])).text;
    expect(text).toContain(`request ${op}: open`);
    expect(text).toContain("not yet answered (pdb question resolve|withdraw)");
    // Reading changed nothing.
    expect(w.issues.get(1)!.comments).toHaveLength(1);
    // #1139 review: a human with no agent identity can read it (an unattributed read).
    const unattributed = await run(w, ["status", "1", "--json"]);
    expect(unattributed.code).toBe(0);
    expect(JSON.parse(unattributed.text).requests).toHaveLength(1);
  });
});

describe("refine resolve (#1096)", () => {
  it("refuses while the question is unanswered, pointing at the question to answer", async () => {
    const w = world();
    w.add(1);
    const op = await request(w);
    const { code, text } = await resolve(w, op);
    expect(code).toBe(1);
    expect(text).toContain("QUESTIONS_UNSETTLED");
    expect(text).toContain(`issuecomment-${w.questionOf(1)}`);
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
  });

  it("clears an answered request, returns the ticket for estimation and states the policy's next step", async () => {
    const w = world();
    w.add(1, ["status:ready", "complexity:M", "agent:jonas"]);
    const op = await request(w);
    await w.answer(1, w.questionOf(1));
    const { code, text } = await resolve(w, op);
    expect(code).toBe(0);
    // Only the index label changes: no readiness, estimate, closure or claim.
    expect(w.issues.get(1)!.labels).toEqual(["status:ready", "complexity:M", "agent:jonas"]);
    expect(text).toContain(
      `Next (estimator, D-REESTIMATE): ${decisionGuidance("D-REESTIMATE")!.why}`,
    );
    expect(text).toContain(denialText("D-DENY-REESTIMATE")!);
    const listed = await status(w);
    expect(listed.body.requests[0]).toMatchObject({ outcome: "resolve", state: "resolved" });
    expect(listed.body.requests[0].resolvedBy).toMatch(/#issuecomment-\d+$/);
    // A replay changes nothing and makes no next-step claim.
    const again = await run(w, [
      "resolve",
      "1",
      "--agent",
      "nicole",
      "--request",
      op,
      "--why",
      "Answered.",
      "--json",
    ]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.text).guidance).toMatchObject({ rule: null, nextActor: null });
  });

  it("refuses a stale clear while a newer request is open, and keeps the label for an older one", async () => {
    const w = world();
    w.add(1);
    const older = await request(w, "First?");
    const newer = await request(w, "Second?");
    await w.answer(1, w.questionOf(1, 0));
    expect((await resolve(w, older)).text).toContain("NEWER_REQUEST_OPEN");
    await w.answer(1, w.questionOf(1, 1));
    expect((await resolve(w, newer)).code).toBe(0);
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
  });

  it("previews both steps on a dry run, and reports a partial write with exit 2", async () => {
    const w = world();
    w.add(1);
    const op = await request(w);
    await w.answer(1, w.questionOf(1));
    const dry = await resolve(w, op, ["--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.text).changes.map((c: { step: string }) => c.step)).toEqual([
      "comment",
      "labels",
    ]);
    expect(w.issues.get(1)!.comments).toHaveLength(2);
    w.failing.add("labels");
    const partial = await resolve(w, op);
    expect(partial.code).toBe(2);
    expect(partial.text).toMatch(/labels: failed/);
    // #1139 review: the label still disagrees with the (now resolved) request, so status is
    // incomplete until the index is reconciled.
    const disagree = await status(w);
    expect(disagree.code).toBe(2);
    expect(disagree.body.labelAgrees).toBe(false);
    expect((await run(w, ["status", "1"])).text).toContain(
      "INCOMPLETE: refinement:needed is present but no request is outstanding",
    );
    w.failing.delete("labels");
    expect((await resolve(w, op)).code).toBe(0);
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
  });

  it("validates arguments and shows help after the subcommand", async () => {
    for (const bad of [
      ["resolve", "1", "--why", "w"],
      ["resolve", "1", "--request", "short", "--why", "w"],
      ["resolve", "1", "--request", "aaaaaaaaaaaaaaaa"],
      ["resolve", "x", "--request", "aaaaaaaaaaaaaaaa", "--why", "w"],
    ])
      expect(() => refineResolveArgumentsFor(bad)).toThrow(refineResolveUsage);
    for (const op of ["resolve", "status"]) {
      let help = "";
      expect(await main(["refine", op, "--help"], async (t) => void (help = t))).toBe(0);
      expect(help).toContain("pdb refine resolve N");
      expect(help).toContain("never answers for you");
    }
  });

  it("says refinement continues, not re-estimation, while another request stays open (#1139 review)", async () => {
    const w = world();
    w.add(1);
    const older = await request(w, "First?");
    const newer = await request(w, "Second?");
    await w.answer(1, w.questionOf(1, 1));
    const { code, text } = await resolve(w, newer, ["--json"]);
    expect(code).toBe(0);
    const guidance = JSON.parse(text).guidance;
    expect(guidance).toMatchObject({ rule: "D-REFINE", nextActor: "designer" });
    expect(guidance.next).toContain(`Still open: ${older}`);
    expect(guidance.pickup).toBe(denialText("D-DENY-REFINEMENT"));
  });

  it("previews the label repair when another request is open and the label is missing (#1139 review)", async () => {
    const w = world();
    w.add(1);
    await request(w, "First?");
    const newer = await request(w, "Second?");
    await w.answer(1, w.questionOf(1, 1));
    w.issues.get(1)!.labels = w.issues.get(1)!.labels.filter((l) => l !== refinementLabel);
    const dry = JSON.parse((await resolve(w, newer, ["--dry-run", "--json"])).text);
    expect(dry.changes.map((c: { step: string }) => c.step)).toEqual(["comment", "labels"]);
    expect(dry.changes[1].command).toContain("--add-label");
  });

  it("promises no label change in a preview when records cannot be verified (#1139 review)", async () => {
    const w = world();
    w.add(1);
    const op = await request(w);
    await w.answer(1, w.questionOf(1));
    // A planner read that succeeds, then an unverifiable record before the preview's second read.
    let reads = 0;
    const query: typeof w.query = async (source, variables) => {
      const answer = (await w.query(source, variables)) as never as {
        repository?: { issueOrPullRequest?: { comments?: { nodes: unknown[] } } };
      };
      const item = answer.repository?.issueOrPullRequest;
      // The planner's read is the first; the preview's own re-read is the second.
      if (!source.startsWith("query{viewer") && item?.comments && ++reads >= 2) {
        const nodes = [
          ...item.comments.nodes,
          { ...(item.comments.nodes[0] as object), databaseId: undefined },
        ];
        // A copy, so the fixture's own comments are untouched.
        return {
          ...answer,
          repository: {
            ...answer.repository,
            issueOrPullRequest: { ...item, comments: { ...item.comments, nodes } },
          },
        } as never;
      }
      return answer as never;
    };
    const { previewRefinementResolve } = await import("./refinement.js");
    const preview = await previewRefinementResolve(
      repo,
      { number: 1, agent: "nicole", request: op, why: "Answered." },
      query,
      w.permission,
    );
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.changes.map((c) => c.step)).toEqual(["comment"]);
    expect((preview.notes ?? []).join(" ")).toMatch(/cannot be confirmed/);
  });
});
