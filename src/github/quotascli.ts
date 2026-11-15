/**
 * `pdb quotas [--json] [--refresh] [--offline]` (#547, doc/design/github-quotas.md "CLI and
 * JSON"). Reads through the shared QuotaService; text is derived from the typed view and JSON is
 * the view itself. No project, repository scan, retry or write.
 */
import { parseArgs } from "node:util";
import { quotaExitCode, QuotaService } from "./quotas.js";
import type {
  QuotaContext,
  QuotaNotice,
  QuotaRest,
  QuotaRow,
  QuotaTelemetrySnapshot,
  QuotaView,
} from "./quotas.js";

export const quotasUsage = "Usage: pdb quotas [--json] [--refresh | --offline]";
export const quotasHelp = `${quotasUsage}
Read-only GitHub API allowance for the gh-selected host and login: one GET /rate_limit plus one
identity read (gh api user). No repository scan, no project needed, no retries, no writes.
  --json      The versioned quota-view (schemaVersion 1) with the same typed facts as the text
  --refresh   Bypass a fresh held reading (a new CLI process holds none, so it always reads)
  --offline   No GitHub requests: show only held readings as stored/unvalidated, else unavailable
  --help      Show this help
Each resource keeps its own unit and reset window; buckets are never added together. Usage is
account-wide and can include other agents, machines and applications; it is not attributed to
any repository or command. Secondary limits have no advance meter and are reported as unmetered.
Warning (80% used) and critical (95%) are PDB display heuristics, not GitHub limits.
Exit: 0 fresh complete view (not permission to send more work); 2 partial, stale or unavailable
evidence; 1 invalid arguments.
`;

export interface QuotasRuntime {
  rest: QuotaRest;
  /** The established gh host/login resolver (one bounded `gh api user`). */
  authContext: (signal?: AbortSignal) => Promise<{ host: string; login: string }>;
  /** The host gh selects (GH_HOST, else github.com), used when the login cannot be read. */
  host: () => string;
  now?: () => Date;
  telemetry?: (context: QuotaContext) => QuotaTelemetrySnapshot | null;
}

export class QuotasUsageError extends Error {}

/** Parse, resolve the context, read once and render. Returns the exit code. */
export async function runQuotas(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: QuotasRuntime,
): Promise<number> {
  let values: { json?: boolean; refresh?: boolean; offline?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        json: { type: "boolean" },
        refresh: { type: "boolean" },
        offline: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    throw new QuotasUsageError(quotasUsage);
  }
  if (values.help) {
    await output(quotasHelp);
    return 0;
  }
  if (values.refresh && values.offline)
    throw new QuotasUsageError(`--refresh and --offline are mutually exclusive. ${quotasUsage}`);
  const service = new QuotaService({
    rest: runtime.rest,
    now: runtime.now,
    telemetry: runtime.telemetry ?? (() => processTelemetry(runtime.now)),
  });
  let context: QuotaContext;
  let contextRequests = 0;
  if (values.offline) context = { host: runtime.host(), login: null };
  else {
    contextRequests = 1;
    try {
      context = await runtime.authContext();
    } catch {
      // Unverified: the gh-selected context is still read once, but nothing is reused and no
      // other login is guessed. The failure detail is never echoed.
      context = { host: runtime.host(), login: null };
    }
  }
  const view = await service.view(context, {
    refresh: !!values.refresh,
    offline: !!values.offline,
    contextRequests,
  });
  await output(values.json ? `${JSON.stringify(view, null, 2)}\n` : quotasText(view));
  return quotaExitCode(view);
}

const started = new Date().toISOString();
/** A fresh CLI process retains no telemetry: an empty window, said honestly. */
const processTelemetry = (now?: () => Date): QuotaTelemetrySnapshot => ({
  scope: "process",
  since: now ? now().toISOString() : started,
  events: [],
  discarded: 0,
});

const names: Record<string, string> = {
  core: "REST core",
  graphql: "GraphQL",
  search: "Search",
  code_search: "Code search",
};
const nameOf = (resource: string): string => names[resource] ?? resource;
const units: Record<QuotaRow["unit"], string> = {
  "rest-requests": "",
  "graphql-points": " points",
  "search-requests": "",
  requests: "",
};

/** `09:42 UTC`, with the date when it is not the day of `now`. */
function clock(iso: string, now: string): string {
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === now.slice(0, 10) ? time : `${iso.slice(0, 10)} ${time}`;
}
const n = (value: number | null): string => (value === null ? "unknown" : String(value));

function rowLine(row: QuotaRow, now: string): string {
  const name = nameOf(row.resource);
  const reset = row.resetAt ? `resets ${clock(row.resetAt, now)}` : "reset unknown";
  const unit = units[row.unit];
  switch (row.state) {
    case "unknown":
      return `${name}: limit ${n(row.limit)}; remaining ${n(row.remaining)}; ${reset} (incomplete reading)`;
    case "inconsistent":
      return `${name}: inconsistent reading (limit ${n(row.limit)}, used ${n(row.used)}, remaining ${n(row.remaining)}); no percentage`;
    case "zero-limit":
      return `${name}: limit 0; no percentage; ${reset}`;
    case "reset-passed":
      return `${name}: reset passed at ${clock(row.resetAt!, now)}; refresh needed (last seen ${n(row.remaining)} remaining)`;
    default: {
      const used = row.usedDerived ? `${row.used} (derived)` : String(row.used);
      const tag = row.state === "normal" ? "" : ` [${row.state}]`;
      return `${name}: ${used} / ${row.limit}${unit} used (${row.percentUsed}%); ${row.remaining} remaining; ${reset}${tag}`;
    }
  }
}

/** Deterministic one-line narration of a notice; null for notices already clear from the rows. */
function noticeLine(notice: QuotaNotice, view: QuotaView): string | null {
  const now = view.generatedAt;
  switch (notice.code) {
    case "pressure": {
      const row = view.resources.find((r) => r.resource === notice.resource)!;
      const reset = row.resetAt ? `until ${clock(row.resetAt, now)}` : "with no known reset";
      return notice.state === "exhausted"
        ? `${nameOf(notice.resource)} is exhausted ${reset}; requests to that bucket are expected to be refused.`
        : `${nameOf(notice.resource)} at ${notice.state} level (${row.percentUsed}% used, ${row.remaining} remaining ${reset}).`;
    }
    case "reset-passed":
      return `${nameOf(notice.resource)}: its reset time has passed; these counts no longer describe current capacity.`;
    case "unknown":
      return `${nameOf(notice.resource)}: GitHub did not report a complete reading; unknown is not zero or healthy.`;
    case "zero-limit":
      return `${nameOf(notice.resource)}: limit is 0; no usable allowance is shown for it.`;
    case "inconsistent":
      return `${nameOf(notice.resource)}: contradictory values (${notice.reasons.join(", ")}); shown as reported, not corrected.`;
    case "omitted-resources":
      return `${notice.count} further resource(s) not shown (cap ${view.coverage.shown}).`;
    case "missing-family":
      return `No ${notice.family} bucket was reported; its allowance is unknown.`;
    case "stale":
      return `Showing a held reading${notice.ageSeconds === null ? " of unknown age" : ` ${notice.ageSeconds}s old`}; it is stale, not current.`;
    case "stored-unvalidated":
      return "Offline: held reading shown as stored and unvalidated.";
    case "clock-rollback":
      return "The clock is earlier than the observation time; its age is unknown.";
    case "refresh-failed":
      return `Quota lookup failed (${notice.category}); nothing was retried.`;
    case "embargo":
      return `GitHub asked the quota lookup to wait until ${clock(notice.retryAt, now)}; not sent early. This is an earliest bound, not a promise.`;
    case "account-unverified":
      return "The gh login could not be verified; the reading is for the gh-selected context and is not reused.";
    case "header-disagrees":
      return `${nameOf(notice.resource)}: a response header at ${clock(notice.header.observedAt, now)} (${notice.header.operation}) reported ${n(notice.header.remaining)} remaining; this aggregate at ${clock(notice.aggregate.observedAt, now)} reports ${n(notice.aggregate.remaining)}. Both are kept.`;
    case "refusal-with-headroom":
      return `${nameOf(notice.resource)}: a request was refused for quota at ${clock(notice.eventAt, now)} although ${notice.remaining} now remain; this reading does not explain that refusal.`;
    case "secondary-observed":
      return `${notice.count} secondary-limit event(s) observed despite the primary meters shown.`;
    case "no-events-in-process":
      return null;
  }
}

/** The text form: header, one line per resource, then brief narration of non-normal states. */
export function quotasText(view: QuotaView): string {
  const who = view.account ?? "unverified login";
  const lines = [
    `GitHub quotas: ${who} on ${view.host} (account-wide; includes other agents and applications)`,
  ];
  lines.push(
    view.observedAt
      ? `Observed ${view.observedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")} via GET /rate_limit (${view.freshness}${view.ageSeconds === null ? ", age unknown" : `, ${view.ageSeconds}s old`})`
      : `No quota reading available (${view.freshness}).`,
  );
  for (const row of view.resources) lines.push(`  ${rowLine(row, view.generatedAt)}`);
  const notes = view.notices
    .map((notice) => noticeLine(notice, view))
    .filter((l): l is string => l !== null);
  if (notes.length) lines.push("Notes:", ...notes.map((l) => `  - ${l}`));
  const s = view.secondary;
  const history = s.events.length
    ? `${s.retained} throttling/resource-limit event(s) retained${s.omitted ? ` (${s.omitted} older not shown)` : ""}${s.discarded ? `; ${s.discarded} discarded` : ""}:`
    : s.scope === "service"
      ? `No events retained since ${s.since ?? "this service started"}; that does not mean no throttling.`
      : "No events observed in this process; that does not mean no throttling.";
  lines.push(`${s.statement}. ${history}`);
  for (const e of s.events)
    lines.push(
      `  ${e.observedAt} ${e.category} (${e.operation})${e.retryAfterSeconds !== null ? `; retry after ${e.retryAfterSeconds}s` : e.retryAt ? `; retry after ${e.retryAt}` : ""}`,
    );
  lines.push(
    `Requests: ${view.requests.quota} quota + ${view.requests.context} identity. PDB display thresholds: warning 80%, critical 95%.`,
  );
  return `${lines.join("\n")}\n`;
}
