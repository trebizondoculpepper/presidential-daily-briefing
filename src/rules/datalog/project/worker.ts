/**
 * Isolated evaluation of a validated project policy (#515,
 * doc/design/native-project-rules.md, "Isolated execution and failure").
 *
 * Project queries never run on the caller's event loop: a DataScript query cannot be preempted
 * once started, so the only bound on a slow or explosive query is terminating its thread. The
 * worker source is a fixed string in this module rather than a separate file, so the packaged
 * build still has a single lazily loaded evaluator chunk and needs no extra file on disk; it
 * loads only the pinned DataScript dependency, through a path this module resolves. It receives
 * bounded projected data and the canonical validated queries, and returns their matched rows.
 * Everything it returns is untrusted: admission.ts validates it before anything is applied.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import type { Datom, Schema } from "datascript";
import { ProjectEvaluationError } from "./projection.js";
import { resultLimits } from "./admission.js";

/** Contract v1 protective limits. Callers may lower them (tests do); they can never raise them. */
export const workerLimits = {
  startupMs: 5000,
  evaluationMs: 500,
  heapMb: 128,
  tuples: resultLimits.tuples,
  outputChars: resultLimits.outputChars,
} as const;
export type WorkerLimits = { -readonly [K in keyof typeof workerLimits]: number };

export interface WorkerJob {
  generation: string;
  effectiveRulesHash: string;
  projectRulesHash: string;
  datoms: readonly Datom[];
  schema: Schema;
  rules: string;
  preferences: {
    id: string;
    matchQuery: string;
    query: string;
    witnesses: [string, string][];
  }[];
}
export interface WorkerOptions {
  signal?: AbortSignal;
  /** False once the effective policy generation has changed; the evaluation is then discarded. */
  isCurrent?: () => boolean;
  limits?: Partial<WorkerLimits>;
}

/** What the worker entry receives as workerData; every input it uses arrives here or by message. */
export interface WorkerData {
  /** Resolved path of the pinned DataScript module. */
  datascript: string;
  tuples: number;
  outputChars: number;
}
/** The untrusted messages the entry posts; runProjectWorker validates each one. */
export type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; text: string }
  | { type: "error"; code: "result-limit" | "output-limit" | "query-failed" };

/**
 * The worker entry. It must stay self-contained: it is serialized with Function.prototype.toString
 * and evaluated in the worker, so it may not reference anything from this module's scope (not
 * even type-erased helpers or named inner functions a transpiler could wrap). It reaches only
 * worker_threads, module (to load DataScript from the resolved path) and DataScript; no fs,
 * network or child processes. worker.test.ts runs the serialized source in an isolated context.
 */
export function workerEntry(): void {
  const threads = process.getBuiltinModule("node:worker_threads");
  const data = threads.workerData as WorkerData;
  const port = threads.parentPort!;
  const ds = process.getBuiltinModule("node:module").createRequire(data.datascript)(
    data.datascript,
  ) as typeof import("datascript").default;
  const post = (message: WorkerMessage): void => port.postMessage(message);
  post({ type: "ready" });
  port.once("message", (job: WorkerJob) => {
    let tuples = 0;
    try {
      const db = ds.init_db([...job.datoms], job.schema);
      const ids = new Map<number, string>();
      for (const [e, a, v] of job.datoms) if (a === "pdb.action-id") ids.set(e, String(v));
      const preferences = [];
      for (const p of job.preferences) {
        const matched = ds.q(p.matchQuery, db, job.rules).map(([a]) => a);
        const found = ds.q(p.query, db, job.rules);
        tuples += matched.length + found.length;
        if (tuples > data.tuples) return post({ type: "error", code: "result-limit" });
        const rows = [];
        for (const [a, value] of found) {
          const witnesses: [string, unknown[]][] = [];
          for (const [name, q] of p.witnesses) {
            const values = ds.q(q, db, job.rules, a).flat();
            tuples += values.length;
            if (tuples > data.tuples) return post({ type: "error", code: "result-limit" });
            witnesses.push([name, values]);
          }
          const entity = Number(a);
          rows.push([
            a,
            ids.has(entity) ? ids.get(entity) : null,
            value,
            Object.fromEntries(witnesses),
          ]);
        }
        preferences.push({ id: p.id, matched, rows });
      }
      const text = JSON.stringify({
        version: 1,
        generation: job.generation,
        effectiveRulesHash: job.effectiveRulesHash,
        projectRulesHash: job.projectRulesHash,
        preferences,
      });
      if (text.length > data.outputChars) post({ type: "error", code: "output-limit" });
      else post({ type: "result", text });
    } catch {
      post({ type: "error", code: "query-failed" });
    }
  });
}
/** The fixed worker source: the compiled entry, invoked once. */
export const workerSource = `"use strict";(${workerEntry.toString()})();`;

const datascriptPath = () => createRequire(import.meta.url).resolve("datascript");
const errorCodes = new Set(["result-limit", "output-limit", "query-failed"]);

/**
 * Run one job in a fresh worker and return its parsed, still untrusted result. Rejects with an
 * explicit ProjectEvaluationError on startup or evaluation timeout, cancellation, a stale
 * generation, heap exhaustion, result or output excess, a query failure or an unexpected message;
 * the worker is always terminated before this settles.
 */
export function runProjectWorker(job: WorkerJob, options: WorkerOptions = {}): Promise<unknown> {
  const limits: WorkerLimits = { ...workerLimits };
  for (const key of Object.keys(workerLimits) as (keyof WorkerLimits)[]) {
    const asked = options.limits?.[key];
    if (asked !== undefined && Number.isFinite(asked) && asked > 0)
      limits[key] = Math.min(asked, workerLimits[key]);
  }
  const { signal, isCurrent = () => true } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProjectEvaluationError("cancelled", "cancelled"));
    if (!isCurrent())
      return reject(new ProjectEvaluationError("stale-generation", "the policy changed"));
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        datascript: datascriptPath(),
        tuples: limits.tuples,
        outputChars: limits.outputChars,
      },
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMb },
    });
    let settled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: ProjectEvaluationError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners("message");
      // Terminate before settling, whatever the outcome: no thread outlives its evaluation.
      void worker.terminate().finally(() => (error ? reject(error) : resolve(value)));
    };
    const fail = (code: string, detail: string) => finish(new ProjectEvaluationError(code, detail));
    const onAbort = () => fail("cancelled", "the evaluation was cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => fail("startup-timeout", `the worker did not start within ${limits.startupMs} ms`),
      limits.startupMs,
    );
    let ready = false;
    worker.on("message", (message: unknown) => {
      const m = (typeof message === "object" && message !== null ? message : {}) as Record<
        string,
        unknown
      >;
      if (!ready && m.type === "ready") {
        ready = true;
        clearTimeout(timer);
        if (!isCurrent()) return fail("stale-generation", "the policy changed");
        timer = setTimeout(
          () =>
            fail(
              "evaluation-timeout",
              `project queries exceeded the ${limits.evaluationMs} ms deadline`,
            ),
          limits.evaluationMs,
        );
        worker.postMessage(job);
        return;
      }
      if (ready && m.type === "error" && typeof m.code === "string" && errorCodes.has(m.code))
        return fail(m.code, "the worker stopped the evaluation");
      if (ready && m.type === "result" && typeof m.text === "string") {
        // The parent enforces the output cap itself rather than trusting the worker's check.
        if (m.text.length > limits.outputChars)
          return fail("output-limit", `output exceeds ${limits.outputChars} characters`);
        if (!isCurrent()) return fail("stale-generation", "the policy changed");
        try {
          return finish(null, JSON.parse(m.text) as unknown);
        } catch {
          return fail("invalid-result", "the worker output is not JSON");
        }
      }
      fail("invalid-result", "unexpected worker message");
    });
    worker.on("error", (error: Error & { code?: string }) =>
      error.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? fail("worker-memory", `the worker exceeded its ${limits.heapMb} MiB heap limit`)
        : fail("worker-failed", "the worker failed"),
    );
    worker.on("exit", () => fail("worker-failed", "the worker exited before answering"));
  });
}
