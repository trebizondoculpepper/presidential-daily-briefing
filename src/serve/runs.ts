/** Explicit, read-only diagnostic executions (#585, doc/design/serve-diagnostics-page.md). */
import { randomUUID } from "node:crypto";
import type { LocalDoctorReport } from "../config/localdoctor.js";
import type { TicketDoctorReport } from "../workflow/ticketdoctor.js";
import type { Clock } from "../mcp/polling.js";
import { CollectionError, MAX_BYTES, MAX_ENTRIES, MAX_CONCURRENT_COLLECTIONS } from "./cache.js";
import { HttpFailure, MAX_RESPONSE_BYTES } from "./http.js";

export type RunKind = "doctor" | "ticket-doctor";
export interface RunRequest {
  kind: RunKind;
  repo: string | null;
  options: { staleHours?: number; limit?: number };
}
export interface RunContext {
  host: string;
  login: string | null;
  repository: string | null;
}
export type RunState = "running" | "completed" | "partial" | "failed" | "cancelled";
export interface RunProgress {
  step: string;
  state: "pending" | "running" | "done" | "skipped";
  detail: string | null;
}
export interface RunStatus {
  schemaVersion: 1;
  kind: "diagnostic-run";
  runId: string;
  /** Absent for passive latest lookup; no subscription is created by a lookup. */
  waiterId?: string;
  run: RunKind;
  context: RunContext;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  progress: RunProgress[];
  result: LocalDoctorReport | TicketDoctorReport | null;
  error: { code: string; message: string; next: string[] } | null;
}
export interface RunLimits {
  active: number;
  retained: number;
  bytes: number;
  waiters: number;
  perRun: number;
  retentionMs: number;
  timeoutMs: number;
  responseBytes: number;
}
export const diagnosticRunLimits: Readonly<RunLimits> = {
  active: MAX_CONCURRENT_COLLECTIONS,
  retained: MAX_ENTRIES,
  bytes: MAX_BYTES,
  waiters: 1024,
  perRun: 128,
  retentionMs: 30 * 60_000,
  timeoutMs: 10 * 60_000,
  responseBytes: MAX_RESPONSE_BYTES,
};
export interface RunRuntime {
  clock: Clock;
  execute(
    request: RunRequest,
    context: RunContext,
    signal: AbortSignal,
    progress: (step: RunProgress) => void,
  ): Promise<{
    result: NonNullable<RunStatus["result"]>;
    complete: boolean;
    quotaRefused?: boolean;
  }>;
  /** Redact every returned string at the trusted host boundary, including progress. */
  redact<T>(value: T): T;
  uuid?: () => string;
  /** Test-only resource seams; not browser or project configuration. */
  limits?: Partial<RunLimits>;
}
interface Execution {
  key: string;
  status: RunStatus;
  controller: AbortController;
  activeWaiters: Set<string>;
  issued: number;
  bytes: number;
  deadline?: unknown;
  expiry?: unknown;
}
interface Waiter {
  execution: Execution;
  createdAt: number;
  cancelled: RunStatus | null;
}
const groups = {
  doctor: ["runtime", "dependencies", "gh", "project", "identity"],
  "ticket-doctor": ["collect", "delivery", "closed-scan", "findings"],
} as const;
const keyOf = (request: RunRequest, context: RunContext) =>
  JSON.stringify([
    request.kind,
    context.host,
    context.login,
    context.repository,
    request.options.staleHours ?? null,
    request.options.limit ?? null,
  ]);
const busy = () =>
  new HttpFailure(
    429,
    "RUNS_BUSY",
    "Diagnostic run capacity is full. Retry after an active run finishes.",
  );

/** A handle grants access to only its own subscription; no operation cancels another waiter. */
export class DiagnosticRuns {
  private readonly limits: RunLimits;
  private readonly executions = new Map<string, Execution>();
  private readonly active = new Map<string, Execution>();
  private readonly latestRuns = new Map<string, Execution>();
  private readonly waiters = new Map<string, Waiter>();
  private closed = false;
  constructor(private readonly runtime: RunRuntime) {
    this.limits = { ...diagnosticRunLimits, ...runtime.limits };
  }
  private now() {
    return this.runtime.clock.now().getTime();
  }
  private uuid() {
    return (this.runtime.uuid ?? randomUUID)();
  }
  private view(execution: Execution, waiterId?: string): RunStatus {
    return structuredClone({ ...execution.status, ...(waiterId ? { waiterId } : {}) });
  }
  private drop(execution: Execution) {
    if (execution.expiry !== undefined) this.runtime.clock.clearTimeout(execution.expiry);
    this.executions.delete(execution.status.runId);
    if (this.latestRuns.get(execution.key) === execution) this.latestRuns.delete(execution.key);
    for (const [id, waiter] of this.waiters)
      if (waiter.execution === execution) this.waiters.delete(id);
  }
  private trim() {
    const terminal = [...this.executions.values()]
      .filter((e) => e.status.state !== "running")
      .sort((a, b) => Date.parse(a.status.finishedAt!) - Date.parse(b.status.finishedAt!));
    let count = terminal.length,
      bytes = terminal.reduce((sum, e) => sum + e.bytes, 0);
    for (const execution of terminal) {
      if (
        this.now() - Date.parse(execution.status.finishedAt!) < this.limits.retentionMs &&
        count <= this.limits.retained &&
        bytes <= this.limits.bytes
      )
        continue;
      count--;
      bytes -= execution.bytes;
      this.drop(execution);
    }
  }
  private reclaimHandles() {
    for (const [id, waiter] of [...this.waiters].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
      if (this.waiters.size < this.limits.waiters) break;
      if (waiter.cancelled || waiter.execution.status.state !== "running") this.waiters.delete(id);
    }
  }
  private finish(
    execution: Execution,
    state: Exclude<RunState, "running">,
    result: RunStatus["result"],
    error: RunStatus["error"] = null,
  ) {
    if (execution.status.state !== "running") return;
    if (execution.deadline !== undefined) this.runtime.clock.clearTimeout(execution.deadline);
    let status: RunStatus = {
      ...execution.status,
      state,
      result,
      error,
      finishedAt: this.runtime.clock.now().toISOString(),
    };
    const size = () => Buffer.byteLength(JSON.stringify({ ...status, waiterId: "0".repeat(36) }));
    let bytes: number;
    try {
      bytes = size();
    } catch {
      status = {
        ...status,
        state: "failed",
        result: null,
        error: {
          code: "INTERNAL",
          message: "The diagnostic result could not be represented.",
          next: [],
        },
      };
      bytes = size();
    }
    if (bytes > this.limits.responseBytes) {
      status = {
        ...status,
        state: "failed",
        result: null,
        error: {
          code: "RESULT_TOO_LARGE",
          message: "The diagnostic result exceeds the response limit.",
          next: [`Use pdb ${execution.status.run} --json on the server for this read.`],
        },
      };
      bytes = size();
    }
    execution.status = status;
    execution.bytes = bytes;
    if (this.active.get(execution.key) === execution) this.active.delete(execution.key);
    if (!this.closed) {
      execution.expiry = this.runtime.clock.setTimeout(
        () => this.drop(execution),
        this.limits.retentionMs,
      );
      this.trim();
    }
  }
  private fail(execution: Execution, code: string, message: string, next: string[] = []) {
    this.finish(execution, "failed", null, { code, message, next });
  }
  private async execute(execution: Execution, request: RunRequest) {
    try {
      const value = await this.runtime.execute(
        request,
        execution.status.context,
        execution.controller.signal,
        (change) => {
          if (execution.status.state !== "running") return;
          const index = execution.status.progress.findIndex((p) => p.step === change.step);
          if (index < 0 || !["running", "done", "skipped"].includes(change.state)) return;
          execution.status.progress[index] = this.runtime.redact({
            step: change.step,
            state: change.state,
            detail:
              change.detail === null ? null : Array.from(change.detail).slice(0, 512).join(""),
          });
        },
      );
      if (execution.status.state !== "running") return;
      const result = structuredClone(this.runtime.redact(value.result));
      this.finish(
        execution,
        value.complete && !value.quotaRefused ? "completed" : "partial",
        result,
        value.quotaRefused
          ? {
              code: "GITHUB_RATE_LIMITED",
              message:
                "GitHub refused further reads for quota; this result contains incomplete evidence.",
              next: [],
            }
          : null,
      );
    } catch (error) {
      if (execution.status.state !== "running") return;
      if (execution.controller.signal.aborted) this.finish(execution, "cancelled", null);
      else if (error instanceof HttpFailure || error instanceof CollectionError) {
        // Only registered server failures are forwarded; never arbitrary exception messages.
        const known: Record<string, string> = {
          GITHUB_AUTH: "GitHub authentication could not be verified.",
          GITHUB_UNAVAILABLE: "GitHub evidence could not be read.",
          GITHUB_RATE_LIMITED:
            "GitHub refused this run for quota. Retry after the shared cooldown.",
          CACHE_INVALIDATED: "The read context changed during this run. Run it again.",
        };
        this.fail(
          execution,
          Object.hasOwn(known, error.code) ? error.code : "INTERNAL",
          known[error.code] ?? "The diagnostic run could not be completed.",
        );
      } else this.fail(execution, "INTERNAL", "The diagnostic run could not be completed.");
    }
  }
  /** Starts or joins synchronously after the adapter has verified and normalized context. */
  start(request: RunRequest, context: RunContext): RunStatus {
    if (this.closed)
      throw new HttpFailure(503, "SHUTTING_DOWN", "Diagnostic runs are shutting down.");
    this.trim();
    this.reclaimHandles();
    const key = keyOf(request, context);
    let execution = this.active.get(key);
    if (
      this.waiters.size >= this.limits.waiters ||
      (execution ? execution.issued >= this.limits.perRun : this.active.size >= this.limits.active)
    )
      throw busy();
    if (!execution) {
      execution = {
        key,
        controller: new AbortController(),
        activeWaiters: new Set(),
        issued: 0,
        bytes: 0,
        status: {
          schemaVersion: 1,
          kind: "diagnostic-run",
          runId: this.uuid(),
          run: request.kind,
          context: { host: context.host, login: context.login, repository: context.repository },
          state: "running",
          startedAt: this.runtime.clock.now().toISOString(),
          finishedAt: null,
          result: null,
          error: null,
          progress: groups[request.kind].map((step) => ({ step, state: "pending", detail: null })),
        },
      };
      this.executions.set(execution.status.runId, execution);
      this.active.set(key, execution);
      this.latestRuns.set(key, execution);
      const owned = execution;
      owned.deadline = this.runtime.clock.setTimeout(() => {
        this.fail(owned, "RUN_TIMEOUT", "The diagnostic run exceeded its ten-minute deadline.");
        owned.controller.abort();
      }, this.limits.timeoutMs);
      // Register the first waiter before starting even an immediately resolved execution.
      queueMicrotask(() => {
        if (owned.status.state === "running") void this.execute(owned, structuredClone(request));
      });
    }
    const waiterId = this.uuid();
    execution.issued++;
    execution.activeWaiters.add(waiterId);
    this.waiters.set(waiterId, { execution, createdAt: this.now(), cancelled: null });
    return this.view(execution, waiterId);
  }
  get(waiterId: string): RunStatus {
    this.trim();
    const waiter = this.waiters.get(waiterId);
    if (!waiter)
      throw new HttpFailure(404, "NOT_FOUND", "That diagnostic waiter is unknown or expired.");
    return waiter.cancelled
      ? structuredClone(waiter.cancelled)
      : this.view(waiter.execution, waiterId);
  }
  cancel(waiterId: string): void {
    this.trim();
    const waiter = this.waiters.get(waiterId);
    if (!waiter || waiter.cancelled || waiter.execution.status.state !== "running") return;
    const execution = waiter.execution;
    waiter.cancelled = {
      ...this.view(execution, waiterId),
      state: "cancelled",
      result: null,
      error: null,
      finishedAt: this.runtime.clock.now().toISOString(),
    };
    execution.activeWaiters.delete(waiterId);
    if (!execution.activeWaiters.size) {
      this.finish(execution, "cancelled", null);
      execution.controller.abort();
    }
  }
  latest(
    request: RunRequest,
    context: RunContext,
  ): Omit<RunStatus, "waiterId"> | { state: "none" } {
    this.trim();
    const execution = this.latestRuns.get(keyOf(request, context));
    return execution ? this.view(execution) : { state: "none" };
  }
  /** Safe counters only, never handles, result payloads, private roots or exception text. */
  counts() {
    return {
      active: this.active.size,
      retained: this.executions.size - this.active.size,
      waiters: this.waiters.size,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const execution of this.executions.values()) {
      if (execution.status.state === "running") {
        this.finish(execution, "cancelled", null);
        execution.controller.abort();
      }
      if (execution.deadline !== undefined) this.runtime.clock.clearTimeout(execution.deadline);
      if (execution.expiry !== undefined) this.runtime.clock.clearTimeout(execution.expiry);
    }
    this.executions.clear();
    this.active.clear();
    this.latestRuns.clear();
    this.waiters.clear();
  }
}
