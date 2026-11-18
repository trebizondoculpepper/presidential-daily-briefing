/** Per-issue cache membership with batched missing reads; no query/page cache. */
import type { IssueFactReader, IssueFacts } from "../github/shortlist.js";
import { readProfiles } from "../github/readplan.js";
import { CollectionError } from "./cache.js";
import type { ServeCache } from "./cache.js";

type Request = Parameters<IssueFactReader>[0];
export type IssueFactBatchReader = (
  numbers: readonly number[],
  signal: AbortSignal,
) => Promise<IssueFacts>;
interface Pending {
  number: number;
  signal: AbortSignal;
  resolve: (facts: IssueFacts) => void;
  reject: (error: unknown) => void;
}
const named = (url: string, number: number) => url.endsWith(`/issues/${number}`);
const slice = (facts: IssueFacts, request: Request, number: number): IssueFacts => {
  const issues = facts.issues.filter((issue) => issue.number === number);
  const gone = facts.gone.filter((url) => named(url, number));
  const unavailable = facts.unavailable.filter(([url]) => named(url, number));
  const coverage = facts.coverage.filter(
    (source) => source.subject === `${request.repository}#${number}`,
  );
  return {
    issues,
    gone,
    unavailable,
    coverage,
    quota: facts.quota,
    notAttempted: facts.notAttempted.filter((url) => named(url, number)),
    warnings: facts.warnings.filter((warning) => warning.includes(`/issues/${number}:`)),
    complete:
      !facts.quota &&
      !unavailable.length &&
      !!(issues.length || gone.length) &&
      coverage.every((source) => source.state === "complete") &&
      issues.every(
        (issue) => !issue.labels.pageInfo.hasNextPage && issue.blockedBy && issue.blocking,
      ),
  };
};

export async function cachedIssueFacts(
  cache: ServeCache,
  request: Request,
  readBatch: IssueFactBatchReader | undefined,
  signal?: AbortSignal,
): Promise<IssueFacts> {
  let pending: Pending[] = [];
  let scheduled = false;
  let running = 0;
  const schedule = () => {
    if (!scheduled && pending.length && running < request.concurrency) {
      scheduled = true;
      queueMicrotask(() => void dispatch());
    }
  };
  const dispatch = async () => {
    scheduled = false;
    const scheduledBatch = pending.splice(0, request.issuesPerRequest);
    const batch = scheduledBatch.filter((task) => !task.signal.aborted);
    for (const task of scheduledBatch)
      if (task.signal.aborted)
        task.reject(task.signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (!batch.length) {
      schedule();
      return;
    }
    running++;
    schedule();
    const controller = new AbortController();
    const abort = () => {
      if (batch.every((task) => task.signal.aborted)) controller.abort();
    };
    for (const task of batch) task.signal.addEventListener("abort", abort, { once: true });
    abort();
    try {
      controller.signal.throwIfAborted();
      if (!readBatch)
        throw new CollectionError("GITHUB_UNAVAILABLE", "No GitHub reader is configured.");
      const facts = await readBatch(
        batch.map((task) => task.number),
        controller.signal,
      );
      if (facts.quota) cache.noteQuotaRefusal(facts.quota);
      for (const task of batch) task.resolve(slice(facts, request, task.number));
    } catch (error) {
      for (const task of batch) task.reject(error);
    } finally {
      for (const task of batch) task.signal.removeEventListener("abort", abort);
      running--;
      schedule();
    }
  };
  const results = await Promise.allSettled(
    request.numbers.map((number) =>
      cache.read(
        {
          repository: request.repository,
          collector: "issue-facts",
          coverage: {
            profile: "briefing-shortlist-v1",
            version: readProfiles["briefing-shortlist-v1"].version,
            phase: "hydrated-issues",
            n: number,
            issuesPerRequest: request.issuesPerRequest,
            concurrency: request.concurrency,
          },
        },
        (inner) =>
          new Promise<IssueFacts>((resolve, reject) => {
            pending.push({ number, signal: inner, resolve, reject });
            schedule();
          }),
        signal,
        (facts) => facts.complete,
      ),
    ),
  );
  signal?.throwIfAborted();
  const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  const quotaError = failures.find(
    (error): error is CollectionError =>
      error instanceof CollectionError && error.code === "GITHUB_RATE_LIMITED",
  );
  const quota =
    values.find((value) => value.quota)?.quota ??
    (quotaError ? { retryAfterSeconds: null, resetAt: null } : null);
  if (failures.length && !quota) throw failures[0];
  for (const [index, result] of results.entries())
    if (result.status === "rejected") {
      const number = request.numbers[index];
      values.push({
        issues: [],
        gone: [],
        unavailable: [
          [`https://github.com/${request.repository}/issues/${number}`, "not-attempted"],
        ],
        coverage: [
          {
            source: "issue",
            subject: `${request.repository}#${number}`,
            state: "not-requested",
            observedAt: null,
            omission: "not attempted after a quota refusal",
            failure: null,
            profileVersion: readProfiles["briefing-shortlist-v1"].version,
          },
        ],
        quota,
        notAttempted: [`https://github.com/${request.repository}/issues/${number}`],
        warnings: [],
        complete: false,
      });
    }
  return {
    issues: values.flatMap((value) => value.issues),
    gone: values.flatMap((value) => value.gone),
    unavailable: values.flatMap((value) => value.unavailable),
    coverage: values.flatMap((value) => value.coverage),
    quota,
    notAttempted: [...new Set(values.flatMap((value) => value.notAttempted))],
    warnings: [...new Set(values.flatMap((value) => value.warnings))],
    complete: values.every((value) => value.complete),
  };
}
