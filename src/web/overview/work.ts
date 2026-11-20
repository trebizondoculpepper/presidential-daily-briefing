/**
 * Overview current-work section client (#825; owner decision on #825: reuse `/api/v1/team`).
 * Parses the existing team view (src/workflow/team.ts plus the delivery responsibilities from
 * src/workflow/deliveryread.ts) into what each agent holds now: claims with their supplied
 * activity or wait reason and linked pull requests, and continuing delivery responsibilities.
 * Nothing here decides a workflow state, infers presence or classifies stalled work; supplied
 * text is displayed as supplied and anything not read stays unknown.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface WorkPull {
  number: number;
  url: string;
  draft: boolean;
  ready: boolean;
  blockers: string[];
}
export interface WorkClaim {
  number: number;
  title: string;
  url: string;
  /** The verified claim activity (#413), e.g. waiting with its reason; null when not read. */
  activity: { state: string; reason: string } | null;
  latestActivity: { at: string; source: string } | null;
  pullRequests: WorkPull[];
}
export interface WorkResponsibility {
  number: number;
  url: string;
  scope: string;
  deliverable: string | null;
  followUp: string | null;
}
export interface WorkAgent {
  agent: string;
  presence: string;
  claims: WorkClaim[];
  responsibilities: WorkResponsibility[];
}
export interface WorkResponse {
  status: "complete" | "incomplete" | "error";
  warnings: string[];
  observedAt: string | null;
  presence: string;
  agents: WorkAgent[];
}

function pull(p: unknown): WorkPull | null {
  if (!isObject(p) || typeof p.number !== "number" || typeof p.url !== "string") return null;
  return {
    number: p.number,
    url: p.url,
    draft: p.draft === true,
    ready: p.ready === true,
    blockers: isStrings(p.blockers) ? p.blockers : [],
  };
}

/** Parse the `/api/v1/team` envelope; null when it is not a team view. */
export function parseWorkResponse(body: unknown): WorkResponse | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  if (r.kind !== "team-view" || !Array.isArray(r.agents)) return null;
  const agents: WorkAgent[] = [];
  for (const a of r.agents) {
    if (!isObject(a) || typeof a.agent !== "string" || !Array.isArray(a.claims)) return null;
    const claims: WorkClaim[] = [];
    for (const c of a.claims) {
      if (!isObject(c) || typeof c.number !== "number" || typeof c.url !== "string") return null;
      const act = isObject(c.activity) ? c.activity : null;
      const last = isObject(c.latestActivity) ? c.latestActivity : null;
      claims.push({
        number: c.number,
        title: str(c.title) ?? c.url,
        url: c.url,
        activity:
          act && typeof act.state === "string"
            ? { state: act.state, reason: str(act.reason) ?? "" }
            : null,
        latestActivity:
          last && typeof last.at === "string"
            ? { at: last.at, source: str(last.source) ?? "" }
            : null,
        pullRequests: (Array.isArray(c.pullRequests) ? c.pullRequests : []).flatMap((p) => {
          const x = pull(p);
          return x ? [x] : [];
        }),
      });
    }
    const responsibilities: WorkResponsibility[] = (
      Array.isArray(a.responsibilities) ? a.responsibilities : []
    ).flatMap((x) =>
      isObject(x) && typeof x.number === "number" && typeof x.url === "string"
        ? [
            {
              number: x.number,
              url: x.url,
              scope: str(x.scope) ?? "ticket",
              deliverable: str(x.deliverable),
              followUp: str(x.followUp),
            },
          ]
        : [],
    );
    agents.push({
      agent: a.agent,
      presence: str(a.presence) ?? "unknown",
      claims,
      responsibilities,
    });
  }
  const completeness = isObject(r.completeness) ? r.completeness : {};
  const freshness = isObject(r.freshness) ? r.freshness : {};
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    warnings: [
      ...(isStrings(completeness.warnings) ? completeness.warnings : []),
      ...(isStrings(body.warnings) ? body.warnings : []),
    ],
    observedAt: str(freshness.fetchedAt) ?? str(r.fetchedAt),
    presence: str(r.presence) ?? "unknown",
    agents,
  };
}

/** The claim's status line, as supplied: verified activity, else "activity not read". */
export function claimStatus(c: WorkClaim): string {
  if (!c.activity) return "activity not read";
  return c.activity.reason ? `${c.activity.state}: ${c.activity.reason}` : c.activity.state;
}

export type WorkState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: WorkResponse }
  | { status: "error"; message: string; code: string | null };

/** One loader for the team read: aborts the previous read; only the newest is reported. */
export function workLoader(api: string, fetcher: typeof fetch, report: (s: WorkState) => void) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null | undefined;
  const read = async (repository: string | null, refresh: boolean): Promise<WorkState | null> => {
    loaded = repository;
    current?.abort();
    const mine = ++sequence;
    if (!repository) {
      current = null;
      report({ status: "no-project" });
      return null;
    }
    const controller = new AbortController();
    current = controller;
    report({ status: "loading" });
    const q = new URLSearchParams({ repo: repository });
    if (refresh) q.set("refresh", "true");
    let state: WorkState;
    try {
      const response = await fetcher(`${api}?${q}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const error = isObject(body) && isObject(body.error) ? body.error : null;
        state = {
          status: "error",
          message:
            str(error?.message) ?? `Current work could not be read (HTTP ${response.status}).`,
          code: str(error?.code),
        };
      } else {
        const parsed = parseWorkResponse(body);
        state = parsed
          ? { status: "ready", response: parsed }
          : {
              status: "error",
              message: "The server returned current work in a format this page does not read.",
              code: null,
            };
      }
    } catch {
      state = {
        status: "error",
        message: "Current work could not be read from the server.",
        code: null,
      };
    }
    if (mine !== sequence || controller.signal.aborted) return null;
    report(state);
    return state;
  };
  return {
    load: (repository: string | null) =>
      repository === loaded ? Promise.resolve(null) : read(repository, false),
    refresh: () => read(loaded ?? null, true),
  };
}
