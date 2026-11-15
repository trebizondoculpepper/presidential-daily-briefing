/**
 * Isolated, bounded project-preference evaluation (#515). These start real worker threads with
 * the shipped DataScript; no network, GitHub, configuration or model is involved.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { rulesHash, policyVersion } from "../engine.js";
import { compileProjectPolicy } from "./compile.js";
import { projectionVocabulary } from "./grammar.js";
import { evaluateProjectPreferences, ProjectEvaluationError } from "./evaluate.js";
import type { ProjectEvaluationOptions } from "./evaluate.js";
import { projectionSchema } from "./projection.js";
import type { AdmittedAction, ProjectionSubject } from "./projection.js";
import { workerLimits } from "./worker.js";

const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = { policyVersion, rulesHash };
const compile = (edit: (t: string) => string = (t) => t) =>
  compileProjectPolicy(
    edit(fixture.replace(/:base-rules-hash "[0-9a-f]{64}"/, `:base-rules-hash "${rulesHash}"`)),
    base,
  );
/** Replace the fixture preference's :when, keeping its priority and witness. */
const withWhen = (when: string) => (t: string) =>
  t.replace(":when [(project-hotfix ?a)]", `:when [${when}]`);
/**
 * Grammatically valid and bounded in size, but a cross product of every action with every pair
 * of unlock counts: on the main thread this exhausts a 4 GiB heap; in the worker it is stopped.
 */
const explosive = compile(
  withWhen(
    '(project-hotfix ?a) [?b "pdb.unlocks" ?x] [?c "pdb.unlocks" ?y] [(+ ?x ?y) ?s] [(= ?s 3)]',
  ),
);

/** The contract's largest projection: 500 adjustable actions in one band, every 5th labelled. */
const actions: AdmittedAction[] = Array.from({ length: 500 }, (_, i) => ({
  id: `o/r https://github.com/o/r/issues/${i + 1} implement`,
  kind: "implement",
  role: "implementer",
  target: `https://github.com/o/r/issues/${i + 1}`,
  band: 6,
  impact: { state: "current", size: "M" },
  complexity: { state: "current", size: "M" },
  unlocks: i,
  unlocksUnknown: [],
}));
const subjects = new Map<string, ProjectionSubject>(
  actions.map((a, i) => [
    a.target,
    {
      labels: ["status:ready", `area:${i % 7}`, ...(i % 5 === 4 ? ["project:priority"] : [])],
      labelsComplete: true,
    },
  ]),
);
const options = (over: Partial<ProjectEvaluationOptions> = {}): ProjectEvaluationOptions => ({
  generation: "g1",
  viewer: { role: "implementer", order: "impact" },
  ...over,
});
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (e instanceof ProjectEvaluationError ? e.code : String(e)),
  );

describe("bounded project worker (#515)", () => {
  it("evaluates the largest representative projection within the v1 limits", async () => {
    const started = performance.now();
    const result = await evaluateProjectPreferences(compile(), actions, subjects, options());
    const elapsed = performance.now() - started;
    expect(result.appliedOrderMode).toBe("impact");
    expect(result.matchedIds).toEqual(["project-hotfix"]);
    // The 100 labelled actions lead in default order, then the rest in default order.
    const labelled = actions.filter((_, i) => i % 5 === 4).map((a) => a.id);
    const rest = actions.filter((_, i) => i % 5 !== 4).map((a) => a.id);
    expect(result.items.map((a) => a.id)).toEqual([...labelled, ...rest]);
    expect(result.items[0].why?.project?.[0]).toMatchObject({ id: "project-hotfix", priority: 10 });
    // Startup plus evaluation, under the separately bounded startup and evaluation deadlines.
    expect(elapsed).toBeLessThan(workerLimits.startupMs + workerLimits.evaluationMs);
  });
  it("keeps the default order exactly under explicit age order, without a worker", async () => {
    for (const order of ["oldest", "newest"]) {
      const result = await evaluateProjectPreferences(
        explosive,
        actions,
        subjects,
        options({ viewer: { role: "implementer", order } }),
      );
      expect(result.appliedOrderMode).toBe("disabled-by-age-order");
      expect(result.items.every((a, i) => a === actions[i])).toBe(true);
    }
  });
  it("terminates an explosive join at the deadline while the caller stays responsive", async () => {
    let last = performance.now(),
      worstGap = 0,
      ticks = 0;
    const interval = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
      ticks++;
    }, 10);
    const deadline = 300,
      started = performance.now();
    try {
      // A lowered deadline, so the timeout (not the later heap exhaustion) stops it everywhere.
      const limits = { evaluationMs: deadline };
      expect(
        await code(evaluateProjectPreferences(explosive, actions, subjects, options({ limits }))),
      ).toBe("evaluation-timeout");
    } finally {
      clearInterval(interval);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(deadline - 5);
    expect(elapsed).toBeLessThan(workerLimits.startupMs + deadline + 1000);
    expect(ticks).toBeGreaterThan(5);
    // Generous for slow CI runners; a query on this thread would block past the whole deadline.
    expect(worstGap).toBeLessThan(250);
  });
  it("cannot raise a limit, only lower it", async () => {
    const started = performance.now();
    expect(
      await code(
        evaluateProjectPreferences(
          explosive,
          actions,
          subjects,
          options({ limits: { evaluationMs: 60_000, heapMb: 4096, tuples: 1e9 } }),
        ),
      ),
    ).toMatch(/^(evaluation-timeout|worker-memory)$/);
    expect(performance.now() - started).toBeLessThan(
      workerLimits.startupMs + workerLimits.evaluationMs + 1000,
    );
  });
  it("reports startup timeout, cancellation and stale generations explicitly", async () => {
    expect(
      await code(
        evaluateProjectPreferences(
          compile(),
          actions,
          subjects,
          options({ limits: { startupMs: 1 } }),
        ),
      ),
    ).toBe("startup-timeout");
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await code(
        evaluateProjectPreferences(
          compile(),
          actions,
          subjects,
          options({ signal: aborted.signal }),
        ),
      ),
    ).toBe("cancelled");
    const cancel = new AbortController();
    const running = code(
      evaluateProjectPreferences(explosive, actions, subjects, options({ signal: cancel.signal })),
    );
    setTimeout(() => cancel.abort(), 50);
    expect(await running).toBe("cancelled");
    let current = true;
    const stale = code(
      evaluateProjectPreferences(
        explosive,
        actions,
        subjects,
        options({ isCurrent: () => current, limits: { evaluationMs: 300 } }),
      ),
    );
    setTimeout(() => (current = false), 20);
    // The generation changes while the worker runs: its result is never applied.
    expect(["stale-generation", "evaluation-timeout"]).toContain(await stale);
    let calls = 0;
    expect(
      await code(
        evaluateProjectPreferences(
          compile(),
          actions,
          subjects,
          options({ isCurrent: () => ++calls < 3 }),
        ),
      ),
    ).toBe("stale-generation");
  });
  it("stops at the heap, tuple and output limits", async () => {
    expect(
      await code(
        evaluateProjectPreferences(
          explosive,
          actions,
          subjects,
          options({ limits: { heapMb: 16 } }),
        ),
      ),
    ).toBe("worker-memory");
    expect(
      await code(
        evaluateProjectPreferences(
          compile(),
          actions,
          subjects,
          options({ limits: { tuples: 50 } }),
        ),
      ),
    ).toBe("result-limit");
    expect(
      await code(
        evaluateProjectPreferences(
          compile(),
          actions,
          subjects,
          options({ limits: { outputChars: 1000 } }),
        ),
      ),
    ).toBe("output-limit");
  });
  it("rejects a :when match whose :priority binds nothing, through the worker", async () => {
    const unpriced = compile((t) =>
      t.replace(
        "[(+ 0 10) ?value] [(not= ?value 0)]",
        '[?a "pdb.action-label" "area:1"] [(+ 0 10) ?value]',
      ),
    );
    expect(await code(evaluateProjectPreferences(unpriced, actions, subjects, options()))).toBe(
      "missing-priority",
    );
  });
  it("rejects recursive or unvalidated policies before any worker starts", async () => {
    expect(() =>
      compile((t) =>
        t.replace(
          ":rules [",
          ':rules [[(project-loop ?a) (project-loop ?a)] [(project-loop ?a) [?a "pdb.action-id" _]] ',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "native-cycle" }));
    const forged = { ...compile(), phase: "grammar-checked" } as unknown as ReturnType<
      typeof compile
    >;
    expect(await code(evaluateProjectPreferences(forged, actions, subjects, options()))).toBe(
      "invalid-policy",
    );
  });
  it("declares the same projection schema the compiler validated against", () => {
    expect(projectionSchema).toEqual(projectionVocabulary.schema);
  });
});
