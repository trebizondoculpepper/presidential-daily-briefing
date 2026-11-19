/**
 * `pdb refine request` (#1095): argument parsing, service wiring through `main`, and the
 * generated guidance in text and JSON receipts. Policy decisions stay in the shared service.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { createAppServices } from "../composition.js";
import { decisionGuidance, denialText } from "../rules/datalog/engine.js";
import { refineArgumentsFor, refineUsage } from "./refinecli.js";
import { refinementLabel } from "./refinement.js";
import { world } from "../testing/refinementworld.js";
import { repo } from "../testing/snapshots.js";
import type { Query } from "../github/github.js";

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
const base = ["request", "1", "--agent", "kavya", "--designer", "nicole", "--why", "Unclear."];

describe("refine request: arguments (#1095)", () => {
  it("parses repeated questions and suggested dependencies", () => {
    const parsed = refineArgumentsFor([
      ...base,
      "--question",
      "Which engine?",
      "--question",
      "  Offline?  ",
      "--dependency",
      `${repo}#7`,
    ]);
    expect(parsed).toMatchObject({
      number: 1,
      designer: "nicole",
      why: "Unclear.",
      questions: ["Which engine?", "Offline?"],
      dependencies: [`${repo}#7`],
      dryRun: false,
      json: false,
    });
  });

  it("rejects missing or blank-only questions and malformed arguments before any write", () => {
    for (const bad of [
      [...base],
      ["request", "x", "--designer", "d", "--why", "w", "--question", "q"],
      ["request", "1", "--why", "w", "--question", "q"],
      ["request", "1", "--designer", "d", "--question", "q"],
      ["resolve", "1", "--designer", "d", "--why", "w", "--question", "q"],
    ])
      expect(() => refineArgumentsFor(bad)).toThrow(refineUsage);
    expect(() => refineArgumentsFor([...base, "--question", "   "])).toThrow(/non-blank/);
  });
});

describe("refine request: service wiring (#1095)", () => {
  it("records the request through the shared service and prints the policy's next step", async () => {
    const w = world();
    w.add(1, ["status:ready", "complexity:M"]);
    const { code, text } = await run(w, [...base, "--question", "Which engine?"]);
    expect(code).toBe(0);
    expect(w.issues.get(1)!.labels).toEqual(["status:ready", "complexity:M", refinementLabel]);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
    expect(text).toMatch(/Refinement request: [0-9a-f]{16}/);
    // The guidance is the native rules' own text, not restated by the CLI.
    expect(text).toContain(`Next (designer, D-REFINE): ${decisionGuidance("D-REFINE")!.why}`);
    expect(text).toContain(denialText("D-DENY-REFINEMENT")!);
    // A retry is safe: nothing is posted twice.
    const again = await run(w, [...base, "--question", "Which engine?"]);
    expect(again.code).toBe(0);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
  });

  it("emits a versioned JSON receipt with steps and guidance", async () => {
    const w = world();
    w.add(1);
    const { code, text } = await run(w, [...base, "--question", "Which engine?", "--json"]);
    expect(code).toBe(0);
    const receipt = JSON.parse(text);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "refinement-request",
      ok: true,
      exitCode: 0,
      guidance: { nextActor: "designer", rule: "D-REFINE" },
    });
    expect(receipt.steps.map((s: { step: string }) => s.step)).toEqual([
      "comment",
      "create-label",
      "labels",
    ]);
    expect(receipt.guidance.request).toMatch(/^[0-9a-f]{16}$/);
  });

  it("writes nothing on a dry run, and reports a partial write with exit 2", async () => {
    const w = world();
    w.add(1);
    const dry = await run(w, [...base, "--question", "Which engine?", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("DRY RUN");
    expect(w.issues.get(1)!.comments).toHaveLength(0);
    w.failing.add("labels");
    const partial = await run(w, [...base, "--question", "Which engine?"]);
    expect(partial.code).toBe(2);
    expect(partial.text).toMatch(/labels: failed/);
  });

  it("refuses an account without write permission, writing nothing", async () => {
    const w = world("outsider");
    w.add(1);
    const { code, text } = await run(w, [...base, "--question", "Which engine?"]);
    expect(code).toBe(1);
    expect(text).toMatch(/MARKER_UNVERIFIED|write permission/);
    expect(w.issues.get(1)!.comments).toHaveLength(0);
  });

  it("prints help", async () => {
    let help = "";
    expect(await main(["refine", "--help"], async (t) => void (help = t))).toBe(0);
    for (const flag of ["--help", "-h"]) {
      let sub = "";
      expect(await main(["refine", "request", flag], async (t) => void (sub = t))).toBe(0);
      expect(sub).toContain("--question TEXT");
    }
    expect(help).toContain("--question TEXT");
    expect(help).toContain("never added as a native dependency");
  });

  it("reads, checks permission and writes through the injected composed GH service only (#1136 review)", async () => {
    const w = world();
    w.add(1);
    const services = createAppServices({
      gh: { query: w.query as unknown as Query, run: w.run, rest: w.rest },
    });
    let text = "";
    const code = await main(
      ["refine", ...base, "--question", "Which engine?", "--repo", repo],
      async (t) => void (text = t),
      {
        collect: async () => {
          throw new Error("no briefing");
        },
        currentRepository: async () => repo,
        services,
      },
    );
    expect(code, text).toBe(0);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
  });

  it("previews both the record and the label in a dry run, and the label repair after a partial write (#1136 review)", async () => {
    const w = world();
    w.add(1);
    const dry = await run(w, [...base, "--question", "Which engine?", "--dry-run", "--json"]);
    expect(JSON.parse(dry.text).changes.map((c: { step: string }) => c.step)).toEqual([
      "comment",
      "create-label",
      "labels",
    ]);
    expect(w.issues.get(1)!.comments).toHaveLength(0);
    w.failing.add("labels");
    await run(w, [...base, "--question", "Which engine?"]);
    w.failing.delete("labels");
    const repair = JSON.parse(
      (await run(w, [...base, "--question", "Which engine?", "--dry-run", "--json"])).text,
    );
    expect(repair.noop).toBe(false);
    expect(repair.changes.map((c: { step: string }) => c.step)).toEqual(["labels"]);
  });

  it("does not claim the next step on a replay, since the questions may have been answered (#1136 review)", async () => {
    const w = world();
    w.add(1);
    await run(w, [...base, "--question", "Which engine?"]);
    await w.answer(1, w.questionOf(1));
    const replay = await run(w, [...base, "--question", "Which engine?"]);
    expect(replay.code).toBe(0);
    expect(replay.text).not.toContain("D-REFINE");
    expect(replay.text).toContain("already recorded");
    const json = JSON.parse(
      (await run(w, [...base, "--question", "Which engine?", "--json"])).text,
    );
    expect(json.guidance).toMatchObject({ rule: null, nextActor: null });
  });

  it("gives no designer guidance when the comment write failed (#1136 review)", async () => {
    const w = world();
    w.add(1);
    w.failing.add("comment");
    const { code, text } = await run(w, [...base, "--question", "Which engine?", "--json"]);
    expect(code).toBe(1);
    const receipt = JSON.parse(text);
    expect(receipt.guidance).toMatchObject({ rule: null, nextActor: null, pickup: null });
    expect(w.issues.get(1)!.comments).toHaveLength(0);
  });

  it("previews that the label cannot be reconciled when an older record is unverifiable (#1136 review)", async () => {
    const w = world();
    w.add(1);
    await run(w, [...base, "--question", "Older question?"]);
    // The older request's author becomes unverifiable.
    w.issues.get(1)!.comments[0]!.author = { __typename: "User", login: "ghost" };
    w.issues.get(1)!.labels = w.issues.get(1)!.labels.filter((l) => l !== refinementLabel);
    const dry = JSON.parse(
      (await run(w, [...base, "--question", "New question?", "--dry-run", "--json"])).text,
    );
    expect(dry.changes.map((c: { step: string }) => c.step)).toEqual(["comment"]);
    expect(dry.notes.join(" ")).toMatch(/would not be reconciled/);
  });
});
