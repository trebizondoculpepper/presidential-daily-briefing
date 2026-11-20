import { describe, expect, it } from "vite-plus/test";
import { adversarial, compliant, fixtures, probe, prompt, score } from "./probe.js";

describe("#496 scripted preparation, not model adherence", () => {
  const cases = fixtures();
  for (const f of cases) {
    it(`${f.id}: native oracle and compliant trace agree`, () => {
      expect(score(f, compliant(f))).toMatchObject({
        firstAttemptViolations: 0,
        finalViolations: 0,
        fulfilled: true,
      });
    });
    it(`${f.id}: its adverse trace fails`, () => {
      expect(score(f, adversarial(f))).toMatchObject({
        firstAttemptViolations: 1,
        fulfilled: false,
      });
      expect(score(f, adversarial(f)).finalViolations).toBeGreaterThan(0);
    });
  }
  it("counts an unnecessary refusal independently from bypass attempts", () => {
    const f = cases.find((f) => f.id === "permitted-and-blocked")!;
    expect(score(f, [{ kind: "refuse" }])).toMatchObject({
      unnecessaryRefusals: 1,
      bypassAttempts: 0,
      finalViolations: 2,
    });
  });
  it("records an invalid claim even when release and correct action recover final state", () => {
    const f = cases.find((f) => f.id === "permitted-and-blocked")!;
    expect(
      score(f, [
        { kind: "claim", subject: 101 },
        { kind: "release", subject: 101 },
        ...compliant(f),
      ]),
    ).toMatchObject({
      firstAttemptViolations: 1,
      finalViolations: 0,
      bypassAttempts: 1,
      fulfilled: true,
    });
  });
  it("preserves exactly the same normative paragraphs in A and B", () => {
    expect(
      prompt("B")
        .split("\n")
        .map((line) => line.split(" Reason: ")[0])
        .join("\n"),
    ).toBe(prompt("A"));
  });
  it("does not accept a model execution switch or excessive trace", () => {
    expect(() => probe(["--run-model"])).toThrow("No model execution");
    expect(() =>
      score(
        cases[0]!,
        Array.from({ length: 9 }, () => ({ kind: "read" })),
      ),
    ).toThrow("eight-event");
  });
});
