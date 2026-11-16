import { beforeAll, describe, expect, it } from "vite-plus/test";
import { resolve } from "node:path";
import { prepareExperiment, scoreResponse } from "../../../scripts/formal-comprehension.js";

describe("offline formal comprehension preparation", () => {
  let pack: Awaited<ReturnType<typeof prepareExperiment>>;
  beforeAll(
    async () => {
      pack = await prepareExperiment(resolve(import.meta.dirname, "../../.."));
      // Manual local research validation: replay every native case and its formal projection,
      // then compile the engine. This exhaustive setup is not part of npm test or CI.
    },
    process.platform === "win32" ? 180_000 : 60_000,
  );
  it("checks the projection against every native scenario and separates answers from prompts", () => {
    expect(pack.manifest.nativeCasesVerified).toBeGreaterThan(70);
    expect(pack.inputs).toHaveLength(12);
    for (const input of pack.inputs) {
      expect(input.prompt).not.toContain('"oracle"');
      expect(input.prompt).not.toContain('"split"');
      expect(input.prompt).not.toContain("preserves-every-attention-destination");
      expect(input.prompt).toContain('"engine.js"');
      expect(input.prompt).toContain('"policy.generated.json"');
      expect(input.conservativeInputReservation).toBeLessThan(65_536);
    }
    expect(pack.manifest.reservedUsd).toBeLessThan(pack.manifest.limits.hardUsd);
  });
  it("distinguishes absent coverage from explicit false", () => {
    const absent = pack.oracles[8]!.probes.find(
      (p) => p.entity === 100 && p.attribute === "labels-complete",
    );
    const negative = pack.oracles[9]!.probes.find(
      (p) => p.entity === 100 && p.attribute === "labels-complete",
    );
    expect(absent).toMatchObject({ known: false, values: [] });
    expect(negative).toMatchObject({ known: true, values: [false] });
  });
  it("scores ordering separately from eligibility and ignores probe presentation order", () => {
    const oracle = pack.oracles.find((x) => x.actions.length > 1)!;
    const answer = structuredClone(oracle);
    answer.actions.reverse();
    answer.probes.reverse();
    const result = scoreResponse(JSON.stringify(answer), oracle);
    expect(result).toMatchObject({
      validShape: true,
      exactOrder: false,
      uncertaintyExact: true,
      eligibility: { precision: 1, recall: 1 },
    });
  });
  it("separates malformed JSON, invalid schema, duplicate actions, and incorrect evidence", () => {
    const oracle = pack.oracles.find((x) => x.actions.length > 0)!;
    expect(scoreResponse("{", oracle)).toMatchObject({ validJson: false });
    expect(scoreResponse("{}", oracle)).toMatchObject({ validJson: true, validShape: false });
    const duplicate = structuredClone(oracle);
    duplicate.actions.push(duplicate.actions[0]!);
    expect(scoreResponse(JSON.stringify(duplicate), oracle)).toMatchObject({ validShape: false });
    const wrong = structuredClone(oracle);
    wrong.actions[0]!.ruleId = "invented";
    wrong.actions[0]!.evidence = { invented: true };
    expect(scoreResponse(JSON.stringify(wrong), oracle)).toMatchObject({
      ruleEvidence: [expect.objectContaining({ rule: false, evidence: false })],
    });
    expect(scoreResponse(JSON.stringify(oracle), oracle)).toMatchObject({
      exactOrder: true,
      uncertaintyExact: true,
    });
  });
});
