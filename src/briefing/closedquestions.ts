/**
 * Questions on closed sources (#414). Contract: doc/reports/closed-question-discovery.md and
 * doc/design/human-briefing.md "Closed sources".
 *
 * A ticket closing (by a merged PR, by hand or as not planned) does not answer its questions.
 * This collector reads closed issues within a fixed request budget, hydrates their comment
 * histories, folds explicit resolve/withdraw records against the exact question they name, and
 * hands the human policy trust, version and outcome facts. It never decides what is shown: the
 * D-HUMAN-ORPHANED* rules do. Whatever it could not read is reported as incomplete coverage,
 * never as "no question" or "answered".
 */
import { createHash, randomUUID } from "node:crypto";
import type { Comment, Issue } from "../github/types.js";
import { comment as commentFields, common, info, prop } from "../github/github.js";
import type { Query, QueryVariables, Rest } from "../github/github.js";
import type { QuestionRecordFact } from "../rules/datalog/datalog.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { questionMarkerPrefix } from "../workflow/claims.js";
import type { HumanRecord } from "./questionrecord.js";
import { emptyQuestionCounts, foldSourceQuestions } from "./questionfold.js";
import type { QuestionCounts } from "./questionfold.js";

/** Request bounds of one closed-source read. */
export interface ClosedQuestionBounds {
  requests: number;
  inventoryPages: number;
  commentPages: number;
  pageSize: number;
  overlapSeconds: number;
}
export const closedQuestionPolicy: Readonly<ClosedQuestionBounds> = {
  /** GitHub requests per read: inventory pages, comment pages and permission lookups together. */
  requests: 13,
  /** Closed-issue inventory pages, newest update first. */
  inventoryPages: 3,
  /** Follow-up comment pages, rotated across sources so none monopolises the budget. */
  commentPages: 10,
  /** Rows per page. */
  pageSize: 100,
  /** How far an incremental `since` pass reaches back before its watermark (clock skew, races). */
  overlapSeconds: 300,
};

/** What the bounded closed-source read covered; `complete` only when nothing was left unread. */
export interface ClosedSourceCoverage {
  read: true;
  complete: boolean;
  bounds: ClosedQuestionBounds;
  requests: number;
  /**
   * This request's inventory pages and rows; `complete` when the baseline inventory has finished
   * (in this request or, in `pdb serve`, across earlier ones).
   */
  inventory: { pages: number; rows: number; complete: boolean };
  /**
   * `baseline`: listing every closed issue, continued across requests in `pdb serve`;
   * `refresh`: after a finished baseline, an overlapping `since` pass over changed issues.
   */
  phase: "baseline" | "refresh";
  /** The scan this request continued; see doc/design/human-briefing.md "Continuation". */
  scan: {
    /** Opaque: server instance, repository, scan start and generation. */
    continuation: string;
    /** `fresh`: started here; `continued`: resumed from memory; `restarted`: memory lost/expired. */
    origin: "fresh" | "continued" | "restarted";
    restartReason: string | null;
    startedAt: string;
    generation: number;
    /** Closed issues updated before this are folded; null until a baseline finishes. */
    watermark: string | null;
    /** The `since` of a refresh pass in progress, or null. */
    refreshSince: string | null;
  };
  /** Closed issues read so far in this scan. */
  discovered: number;
  /** Closed issues whose whole comment history was read. */
  hydrated: number;
  /** Closed issues with comment pages left unread, by URL. */
  pending: string[];
  /** Permission lookups that could not be made or answered. */
  permissionGaps: number;
  records: QuestionCounts;
  startedAt: string;
  fetchedAt: string;
  failure: string | null;
}
/** Closed-source discovery that did not run (offline, cached, or no GraphQL boundary). */
export interface ClosedSourceNotRead {
  read: false;
  complete: false;
  why: string;
}

/** A closed source carrying at least one trusted question the policy must consider. */
export interface ClosedSource {
  issue: Issue;
  facts: QuestionRecordFact[];
  /** Trusted records not settled by an explicit outcome, newest first. */
  records: HumanRecord[];
}
export interface ClosedQuestions {
  read: true;
  sources: ClosedSource[];
  coverage: ClosedSourceCoverage;
  /** `${url}: …` warnings; every one also makes the coverage incomplete. */
  warnings: string[];
}

export interface ClosedQuestionRuntime {
  query: Query;
  /** Permission REST boundary; each lookup consumes the same budget. */
  rest?: Rest;
  /** Builds the #212 trust rule over a (budgeted) REST boundary. */
  trustWith?: (rest: Rest) => TrustDecision;
  /** Fallback trust when no REST boundary is given; its lookups are not budgeted here. */
  trust?: TrustDecision;
  now?: () => Date;
  signal?: AbortSignal;
  bounds?: Partial<ClosedQuestionBounds>;
  /**
   * Scan progress kept between requests (`pdb serve`); absent, each read starts afresh. One slot
   * per served project and repository: progress is never shared between them.
   */
  slot?: ClosedScanSlot;
}

const inventorySource = (size: number) =>
  `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:${size},after:$cursor,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${common}} ${info}}} rateLimit{remaining resetAt}}`;
const sinceSource = (size: number) =>
  `query($owner:String!,$name:String!,$cursor:String,$since:DateTime!){repository(owner:$owner,name:$name){issues(first:${size},after:$cursor,states:CLOSED,filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${common}} ${info}}} rateLimit{remaining resetAt}}`;
const commentsSource = (size: number) =>
  `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:${size},after:$cursor){nodes{${commentFields}} ${info}}}}}}`;

class BudgetExhausted extends Error {}

const pageOf = (value: unknown): { nodes: unknown[]; more: boolean; cursor: string | null } => {
  const nodes = prop(value, "nodes");
  const cursor = prop(value, "pageInfo", "endCursor");
  if (!Array.isArray(nodes)) throw new Error("the response has no page of nodes");
  return {
    nodes,
    more: prop(value, "pageInfo", "hasNextPage") === true,
    cursor: typeof cursor === "string" ? cursor : null,
  };
};

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A closed issue being read: its comments so far and the cursor of the next page (null: done). */
interface Entry {
  issue: Issue;
  comments: Comment[];
  next: string | null;
}
/** One scan's progress. Nothing here is a GitHub snapshot: pages are observed over time. */
export interface ClosedScanState {
  startedAt: string;
  generation: number;
  /** Baseline inventory cursor; null before the first page. */
  inventoryCursor: string | null;
  inventoryDone: boolean;
  /** Issues still being hydrated, and hydrated ones that carry a question or resolution marker. */
  entries: Map<string, Entry>;
  /** Every closed issue URL seen in this scan. */
  seen: Set<string>;
  watermark: string | null;
  /** An incremental pass in progress: its `since`, its start and its cursor. */
  refresh: { since: string; startedAt: string; cursor: string | null; listed: boolean } | null;
  lastUsed: number;
}

const freshState = (now: Date): ClosedScanState => ({
  startedAt: now.toISOString(),
  generation: 0,
  inventoryCursor: null,
  inventoryDone: false,
  entries: new Map(),
  seen: new Set(),
  watermark: null,
  refresh: null,
  lastUsed: now.getTime(),
});

/** One served project/repository's scan, with a lock so concurrent requests do not interleave. */
export interface ClosedScanSlot {
  readonly key: string;
  readonly instance: string;
  readonly retentionMs: number;
  state: ClosedScanState | null;
  /** Why the last state was discarded; reported once by the next read. */
  lost: string | null;
  lock: Promise<unknown>;
}

/**
 * In-memory scan progress for `pdb serve` (#414): one slot per served project and repository,
 * kept while used within `retentionMs`. Restarting the server, a manual refresh or idle expiry
 * loses it, and the next read says so and starts again.
 */
export class ClosedQuestionStore {
  readonly instance = randomUUID();
  private readonly slots = new Map<string, ClosedScanSlot>();
  constructor(readonly retentionMs: number) {}
  slot(project: string | undefined, repository: string): ClosedScanSlot {
    const key = `${project ?? ""}\u0000${repository.toLowerCase()}`;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        key,
        instance: this.instance,
        retentionMs: this.retentionMs,
        state: null,
        lost: null,
        lock: Promise.resolve(),
      };
      this.slots.set(key, slot);
    }
    return slot;
  }
  /** Discard progress (manual refresh, login change) so the next read restarts and says why. */
  reset(repository: string | undefined, why: string): void {
    for (const slot of this.slots.values())
      if (!repository || slot.key.endsWith(`\u0000${repository.toLowerCase()}`))
        if (slot.state) {
          slot.state = null;
          slot.lost = why;
        }
  }
}

const continuationId = (slot: ClosedScanSlot | undefined, repository: string, s: ClosedScanState) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        slot?.instance ?? "unsaved",
        slot?.key ?? repository,
        s.startedAt,
        s.generation,
      ]),
    )
    .digest("hex")
    .slice(0, 24);

/**
 * Read closed issues and their question records within the bounds. `exclude` holds URLs read as
 * open in the snapshot, which keep the open-ticket contract. With a slot, the scan continues
 * where the previous request stopped, then refreshes incrementally once its baseline is done.
 */
export async function discoverClosedQuestions(
  repository: string,
  runtime: ClosedQuestionRuntime,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ClosedQuestions> {
  const slot = runtime.slot;
  if (!slot) return scan(repository, runtime, exclude, undefined);
  const run = slot.lock.then(() => scan(repository, runtime, exclude, slot));
  slot.lock = run.catch(() => undefined);
  return run;
}

async function scan(
  repository: string,
  runtime: ClosedQuestionRuntime,
  exclude: ReadonlySet<string>,
  slot: ClosedScanSlot | undefined,
): Promise<ClosedQuestions> {
  const bounds: ClosedQuestionBounds = { ...closedQuestionPolicy, ...runtime.bounds };
  const now = runtime.now ?? (() => new Date());
  const signal = runtime.signal;
  const [owner, name] = repository.split("/");
  const requestStart = now();
  const warnings: string[] = [];

  // Continue the slot's scan, or start one, saying why when earlier progress is gone.
  let origin: ClosedSourceCoverage["scan"]["origin"] = "fresh";
  let restartReason: string | null = null;
  let state = slot?.state ?? null;
  if (slot && state && requestStart.getTime() - state.lastUsed > slot.retentionMs) {
    state = null;
    slot.lost = `the previous scan was idle longer than ${Math.round(slot.retentionMs / 1000)}s and expired`;
  }
  if (state) origin = "continued";
  else {
    if (slot?.lost) {
      origin = "restarted";
      restartReason = slot.lost;
      slot.lost = null;
    }
    state = freshState(requestStart);
    if (slot) slot.state = state;
  }
  state.lastUsed = requestStart.getTime();
  const s = state;

  let used = 0;
  let permissionGaps = 0;
  const take = () => {
    if (used >= bounds.requests) throw new BudgetExhausted();
    used++;
  };
  const request = async (source: string, variables: QueryVariables) => {
    take();
    const data = await runtime.query(source, {
      owner: owner ?? "",
      name: name ?? "",
      ...variables,
    });
    const repo = prop(data, "repository");
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };
  // Permission lookups spend the same budget; past it they answer nothing, which the #212 rule
  // reads as unknown authority (missing evidence), never as trusted or untrusted.
  const budgetedRest: Rest | undefined = runtime.rest
    ? async (path, options) => {
        if (used >= bounds.requests) {
          permissionGaps++;
          return { status: null, body: null };
        }
        used++;
        return runtime.rest!(path, options);
      }
    : undefined;
  const trust = budgetedRest && runtime.trustWith ? runtime.trustWith(budgetedRest) : runtime.trust;

  /** A listed issue replaces what the scan knew of it: its comments are reread from page one. */
  const observe = (node: Issue) => {
    if (node.state !== "CLOSED") return;
    s.seen.add(node.url);
    s.entries.set(node.url, {
      issue: node,
      comments: [...node.comments.nodes],
      next: node.comments.pageInfo.hasNextPage ? (node.comments.pageInfo.endCursor ?? "") : null,
    });
  };

  let pages = 0;
  let rows = 0;
  let failure: string | null = null;
  const phase: ClosedSourceCoverage["phase"] = s.watermark ? "refresh" : "baseline";
  try {
    // 1. List: the baseline inventory, or after it an overlapping `since` pass. A cursor only
    // advances after its page was read, so a failure or the bound never skips a page.
    if (phase === "baseline" && !s.inventoryDone)
      while (pages < bounds.inventoryPages) {
        signal?.throwIfAborted();
        const page = pageOf(
          prop(
            await request(
              inventorySource(bounds.pageSize),
              s.inventoryCursor ? { cursor: s.inventoryCursor } : {},
            ),
            "issues",
          ),
        );
        pages++;
        rows += page.nodes.length;
        // Pages of a mutable list can shift: the first observation of an issue in a scan stays.
        for (const node of page.nodes as Issue[]) if (!s.seen.has(node.url)) observe(node);
        if (!page.more || !page.cursor) {
          s.inventoryDone = true;
          break;
        }
        s.inventoryCursor = page.cursor;
      }
    if (phase === "refresh") {
      if (!s.refresh) {
        const since = new Date(Date.parse(s.watermark!) - bounds.overlapSeconds * 1000);
        s.refresh = {
          since: since.toISOString(),
          startedAt: requestStart.toISOString(),
          cursor: null,
          listed: false,
        };
      }
      const r = s.refresh;
      while (!r.listed && pages < bounds.inventoryPages) {
        signal?.throwIfAborted();
        const page = pageOf(
          prop(
            await request(sinceSource(bounds.pageSize), {
              since: r.since,
              ...(r.cursor ? { cursor: r.cursor } : {}),
            }),
            "issues",
          ),
        );
        pages++;
        rows += page.nodes.length;
        // A changed issue is refolded from its current state.
        for (const node of page.nodes as Issue[]) observe(node);
        if (!page.more || !page.cursor) r.listed = true;
        else r.cursor = page.cursor;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof BudgetExhausted)) failure = `inventory: ${failureText(error)}`;
  }

  // 2. Hydrate truncated comment histories, one page per source in rotation.
  let commentPages = 0;
  const queue = [...s.entries].filter(([, e]) => e.next !== null).map(([url]) => url);
  try {
    while (queue.length && commentPages < bounds.commentPages) {
      signal?.throwIfAborted();
      const url = queue.shift()!;
      const entry = s.entries.get(url)!;
      const page = pageOf(
        prop(
          await request(commentsSource(bounds.pageSize), {
            number: entry.issue.number,
            ...(entry.next ? { cursor: entry.next } : {}),
          }),
          "issueOrPullRequest",
          "comments",
        ),
      );
      commentPages++;
      entry.comments.push(...(page.nodes as Comment[]));
      if (page.more && page.cursor) {
        entry.next = page.cursor;
        queue.push(url);
      } else entry.next = null;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof BudgetExhausted))
      failure = [failure, `comments: ${failureText(error)}`].filter(Boolean).join("; ");
  }
  const pending = [...s.entries].filter(([, e]) => e.next !== null).map(([url]) => url);
  // Hydrated issues without any marker hold nothing to fold: keep only their URL.
  for (const [url, e] of s.entries)
    if (e.next === null && !e.comments.some((c) => (c.body ?? "").includes("<!-- github-triage:")))
      s.entries.delete(url);

  // 3. Advance the watermark only past fully read listings and comment histories.
  if (!failure && !pending.length) {
    if (phase === "baseline" && s.inventoryDone) {
      s.watermark = s.startedAt;
      s.generation++;
    } else if (phase === "refresh" && s.refresh?.listed) {
      s.watermark = s.refresh.startedAt;
      s.refresh = null;
      s.generation++;
    }
  }
  const listingDone = phase === "baseline" ? s.inventoryDone : !s.refresh;
  if (failure)
    warnings.push(
      `${repository}: the closed-ticket read failed (${failure}); questions on unread closed tickets are unknown. Progress is kept and the next read retries.`,
    );
  else if (phase === "baseline" && !s.inventoryDone)
    warnings.push(
      `${repository}: closed tickets beyond the ${s.seen.size} read so far were not read (bound: ${bounds.inventoryPages} page(s) of ${bounds.pageSize} per read); questions on them are unknown, not absent.${slot ? " The next read continues the scan." : ""}`,
    );
  else if (phase === "refresh" && s.refresh && !s.refresh.listed)
    warnings.push(
      `${repository}: closed tickets changed since ${s.refresh.since} were not all read within the bound; changes to their questions are unknown. The next read continues the refresh.`,
    );
  for (const url of pending)
    warnings.push(
      `${url}: closed ticket's comment history was not fully read within the bound; its questions and their resolutions are unknown.`,
    );
  if (restartReason)
    warnings.push(`${repository}: closed-ticket scan restarted: ${restartReason}.`);

  // 4. Fold each source's question records and explicit outcomes.
  const counts = emptyQuestionCounts();
  const sources: ClosedSource[] = [];
  for (const [url, entry] of s.entries) {
    signal?.throwIfAborted();
    if (exclude.has(url)) continue;
    if (!entry.comments.some((c) => (c.body ?? "").includes(questionMarkerPrefix))) continue;
    const folded = await foldSourceQuestions(
      repository,
      entry.issue,
      entry.comments,
      entry.next === null,
      trust,
      counts,
      warnings,
      "this closed ticket",
    );
    if (folded.questions.length)
      sources.push({
        issue: { ...entry.issue, comments: { ...entry.issue.comments, nodes: entry.comments } },
        facts: folded.questions.map((q) => q.fact),
        records: folded.open,
      });
  }
  if (permissionGaps)
    warnings.push(
      `${repository}: ${permissionGaps} permission lookup(s) for closed-ticket records exceeded the request bound; those records are unverified.`,
    );
  const coverage: ClosedSourceCoverage = {
    read: true,
    complete: listingDone && !pending.length && !failure && !warnings.length,
    bounds,
    requests: used,
    inventory: { pages, rows, complete: s.inventoryDone },
    phase,
    scan: {
      continuation: continuationId(slot, repository, s),
      origin,
      restartReason,
      startedAt: s.startedAt,
      generation: s.generation,
      watermark: s.watermark,
      refreshSince: s.refresh?.since ?? null,
    },
    discovered: s.seen.size,
    hydrated: s.seen.size - pending.length,
    pending,
    permissionGaps,
    records: counts,
    startedAt: requestStart.toISOString(),
    fetchedAt: now().toISOString(),
    failure,
  };
  return { read: true, sources, coverage, warnings };
}
