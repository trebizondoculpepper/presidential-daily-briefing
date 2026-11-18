/** Native dependency queries and pure facts. Contract: doc/issue-dependencies.md. */
import { execFileTransport } from "./service/transport.js";
import type { GhTransport } from "./service/transport.js";
import {
  ghQuery,
  ghQueryWith,
  isRecord,
  pages,
  declaredDependencies,
  prop,
  selected,
  SubjectUnavailable,
} from "./github.js";
import type { Query } from "./github.js";
import {
  classifyCommentResponse,
  commentCommand,
  sameCommentBody,
  withCommentRecovery,
} from "./commentwrite.js";
import type { CommentCallOptions, CommentReceipt } from "./commentwrite.js";
import { parseGhResponse } from "./evidence.js";
import type { GhResponse } from "./evidence.js";
import type { Issue, NativeNode, Page, Reference } from "./types.js";
import { QuotaStopped, quotaRefusal, ReadMeter, readProfiles } from "./readplan.js";
import type { ReadCollection } from "./readplan.js";

const pageInfo = "pageInfo { hasNextPage endCursor }";
export const summaryFields =
  "issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }";
const nodeFields = `number title state stateReason url repository { nameWithOwner } ${summaryFields}`;
export const nativeFields = `${summaryFields} blockedBy(first:100) { nodes { ${nodeFields} } ${pageInfo} } blocking(first:100) { nodes { ${nodeFields} } ${pageInfo} }`;

/** The native-dependency fields of an issue, as optionally present in collected facts. */
export type NativeFields = Pick<Issue, "issueDependenciesSummary" | "blockedBy" | "blocking">;
/** Native-dependency fields whose evidence is present. */
export type KnownNative = Required<NativeFields>;
/** The subset of an issue that a dependency read selects. */
export type DependencyIssue = Pick<
  Issue,
  "number" | "title" | "body" | "url" | "state" | "stateReason" | "updatedAt" | "labels"
> &
  Partial<Pick<Issue, "createdAt" | "closedByPullRequestsReferences">> &
  NativeFields;
/**
 * Eligibility facts of one direct dependant (#196): enough for the shared pickup gates, never
 * its discussion. `blockedBy` lists at most `dependantBlockersListed` of its blockers; its own
 * dependants were not read.
 */
export type DependantFacts = Pick<
  Issue,
  "number" | "title" | "url" | "state" | "stateReason" | "createdAt" | "labels"
> &
  Required<Pick<Issue, "issueDependenciesSummary" | "closedByPullRequestsReferences">> & {
    repository: { nameWithOwner: string };
    blockedBy: Page<Pick<NativeNode, "number" | "url" | "state" | "stateReason">>;
  };
/** Direct-impact evidence attached to a routine `deps N` read (#196). */
export interface DirectEvidence {
  /** The selected issue's eligibility facts; absent when they were not read. */
  subject: {
    state: string;
    stateReason: string | null;
    createdAt: string | null;
    closedByPullRequestsReferences: Issue["closedByPullRequestsReferences"] | null;
    labels: Issue["labels"];
  };
  /** Hydrated last-open-blocker dependants. */
  dependants: DependantFacts[];
  /** Last-open-blocker dependants not hydrated: beyond the bound, or after a quota refusal. */
  notRead: { url: string; reason: string }[];
  /** Read dependants whose own blocker list was truncated: their evidence is partial. */
  partial?: { url: string; reason: string }[];
}

export async function completeNative<T extends NativeFields & Pick<Issue, "number" | "url">>(
  item: T,
  repository: string,
  query: Query = ghQuery,
): Promise<T & KnownNative> {
  const fields = ["blockedBy", "blocking"] as const;
  for (const field of fields) {
    const initial = item[field];
    if (!initial || !item.issueDependenciesSummary)
      throw new Error(`Native dependency evidence missing for ${item.url}.`);
    initial.nodes = await pages<NativeNode>(async (cursor) => {
      if (!cursor) return initial;
      const [owner, name] = repository.split("/");
      const data = await query(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){${field}(first:100,after:$cursor){nodes{${nodeFields}} ${pageInfo}}}}}`,
        { owner, name, number: item.number, cursor },
      );
      return prop(data, "repository", "issue", field);
    });
    initial.pageInfo = { hasNextPage: false, endCursor: null };
    const expected =
      item.issueDependenciesSummary[field === "blockedBy" ? "totalBlockedBy" : "totalBlocking"];
    if (initial.nodes.length !== expected)
      throw new Error(
        `Native dependency count changed or is incomplete for ${item.url}; refresh live.`,
      );
  }
  const { issueDependenciesSummary, blockedBy, blocking } = item;
  if (!issueDependenciesSummary || !blockedBy || !blocking)
    throw new Error(`Native dependency evidence missing for ${item.url}.`);
  // Reassigns the same values (no change): returns the same object, typed as complete.
  return Object.assign(item, { issueDependenciesSummary, blockedBy, blocking });
}
export const nativeKnown = <T extends NativeFields>(item: T): item is T & KnownNative =>
  !!item.issueDependenciesSummary && !!item.blockedBy && !!item.blocking;
export const pickable = (item: NativeFields): boolean =>
  nativeKnown(item) && item.issueDependenciesSummary.blockedBy === 0;
export const dependencyDrift = (
  item: Pick<Issue, "body" | "blockedBy">,
  repository: string,
): Reference[] =>
  declaredDependencies(item.body, repository).filter(
    (ref) => !(item.blockedBy?.nodes ?? []).some((n) => n.url === ref.url),
  );
export interface DependencyFacts {
  number: number;
  url: string;
  title: string;
  known: boolean;
  summary: Issue["issueDependenciesSummary"] | null;
  upstream: NativeNode[];
  /**
   * `lastOpenBlocker` is a structural edge fact for the deps diagnostic only. It is not impact:
   * no ordering uses it; impact is ranking.ts `immediateUnlocks` (#208).
   */
  downstream: (NativeNode & { lastOpenBlocker: boolean })[];
  drift: Reference[];
  verdict: string;
}
export function dependencyFacts(
  item: Pick<Issue, "number" | "url" | "title" | "body" | "state"> & NativeFields,
  repository: string,
): DependencyFacts {
  const known = nativeKnown(item);
  const blockers = item.blockedBy?.nodes ?? [];
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    known,
    summary: item.issueDependenciesSummary ?? null,
    upstream: blockers,
    downstream: (item.blocking?.nodes ?? []).map((node) => ({
      ...node,
      lastOpenBlocker:
        item.state === "OPEN" &&
        node.state === "OPEN" &&
        node.issueDependenciesSummary?.blockedBy === 1,
    })),
    drift: dependencyDrift(item, repository),
    verdict: !nativeKnown(item)
      ? "Unknown native dependency evidence; refresh live."
      : blockers.some((n) => n.stateReason === "NOT_PLANNED")
        ? "A blocker was closed as not planned; human inspection required."
        : item.issueDependenciesSummary.blockedBy > 0
          ? `Waiting on ${blockers
              .filter((n) => n.state === "OPEN")
              .map((n) => n.url)
              .join(", ")}`
          : "No open native blockers; pickup still requires ready, unclaimed and acceptance verification.",
  };
}
/** Eligibility facts beyond native edges: creation time and open closing-PR identities. */
const eligibilityFields = `createdAt closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} ${pageInfo}}`;
export async function readDependencyIssue(
  repository: string,
  number: number,
  query: Query = ghQuery,
  eligibility = false,
): Promise<DependencyIssue & KnownNative> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title body url state stateReason updatedAt ${eligibility ? `${eligibilityFields} ` : ""}labels(first:100){nodes{name} ${pageInfo}} ${nativeFields}}}}`,
    { owner, name, number },
  );
  const item = selected<DependencyIssue>(prop(data, "repository", "issue"));
  if (!item)
    throw new SubjectUnavailable(
      `Issue #${number} unavailable; pull requests cannot be native blockers.`,
    );
  return completeNative(item, repository, query);
}
export interface DependencyReport {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  tree: boolean;
  nodes: DependencyFacts[];
  cycles: string[][];
  guidance: string;
  /**
   * Tree nodes in repositories the caller may not read (`pdb serve` reads only its served set,
   * #373): known only from the edge, never walked. Absent when nothing was skipped.
   */
  unfollowed?: { repository: string; number: number }[];
  /**
   * Profile, per-source coverage and cost of this read (#367). Discussion, reviews and linked
   * pull requests are `not-requested`: the report says nothing about them.
   */
  collection?: ReadCollection;
  /**
   * How far an explicit `--tree` walk got (#196). Absent for a direct read. `complete` is true
   * only when every reachable issue was read; a walk stopped by its node limit or a quota
   * refusal is partial, and its cycles are only those among the issues read.
   */
  treeBounds?: TreeBounds;
  /** Eligibility evidence for the selected issue's direct impact; only when requested. */
  direct?: DirectEvidence;
}
/** The bound and outcome of one `deps --tree` walk. */
export interface TreeBounds {
  complete: boolean;
  /** Effective node limit for this walk. */
  nodeLimit: number;
  nodesRead: number;
  /** Why the walk stopped early; null when it did not stop (it may still be incomplete). */
  stoppedBy: "node-limit" | "quota" | null;
  /** Issues in repositories the caller may not read (`unfollowed`); each makes it incomplete. */
  notServed: number;
  /**
   * Distinct issues known from an edge but not read. A lower bound: their own edges were never
   * read, so more issues beyond them may exist ("more not read").
   */
  notRead: number;
  /** The first of those identities in walk order, at most `notReadListed`. */
  notReadSample: { repository: string; number: number }[];
  /** False when the walk is partial: a cycle through an unread issue would not be seen. */
  cyclesComplete: boolean;
}
/** Default and maximum `--tree` node limits. */
export const treeNodeLimit = readProfiles["dependency-tree-v1"].bounds.treeNodes;
export const treeNodeMaximum = 500;
/**
 * Read one ticket's native dependencies; with `tree`, walk upstream and downstream
 * transitively, breadth first, reading each ticket once up to `maxNodes` tickets, and report
 * upstream (blocked-by) cycles among the tickets read. A stopped walk says what it did not read.
 */
export async function dependencyReport(
  repository: string,
  number: number,
  {
    tree = false,
    signal,
    follow,
    maxNodes = treeNodeLimit,
    impact = false,
  }: {
    /** Also read direct dependants' eligibility for a direct-impact answer (#196). */
    impact?: boolean;
    tree?: boolean;
    signal?: AbortSignal;
    follow?: (repository: string) => boolean;
    maxNodes?: number;
  } = {},
  query: Query = ghQueryWith(signal),
  now: () => Date = () => new Date(),
): Promise<DependencyReport> {
  const startedAt = now().toISOString();
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > treeNodeMaximum)
    throw new Error(`The tree node limit must be 1–${treeNodeMaximum}.`);
  if (impact && tree)
    throw new Error("Direct impact is a routine read; it is not a --tree option.");
  const meter = new ReadMeter(
    tree ? "dependency-tree-v1" : impact ? "dependency-direct-v1" : "issue-detail-v1",
    tree ? "deps-tree" : "deps",
    now,
    undefined,
    signal,
  );
  const nodes = new Map<string, DependencyFacts>();
  const pending: [string, number][] = [[repository, number]];
  const unfollowed = new Map<string, { repository: string; number: number }>();
  let stoppedBy: TreeBounds["stoppedBy"] = null;
  let direct: DirectEvidence | undefined;
  for (let next = pending.shift(); next; next = pending.shift()) {
    const [repo, n] = next;
    // GitHub owner/name are case-insensitive: one issue is one node however an edge spells it.
    const key = `${repo.toLowerCase()}#${n}`;
    if (nodes.has(key) || unfollowed.has(key)) continue;
    if (follow && !follow(repo)) {
      unfollowed.set(key, { repository: repo, number: n });
      meter.cover("issue", key, "not-requested", { omission: "repository not served; not read" });
      continue;
    }
    if (nodes.size >= maxNodes) {
      // Bounded expansion: keep this identity (and the rest) as "not read", never drop it.
      pending.unshift(next);
      stoppedBy = "node-limit";
      break;
    }
    signal?.throwIfAborted();
    let item: Awaited<ReturnType<typeof readDependencyIssue>>;
    try {
      item = await readDependencyIssue(repo, n, meter.query(query, "issue", key), impact);
    } catch (error) {
      // The selected ticket must be read; a later quota refusal stops the walk, keeping what
      // was read and reporting the rest as not read rather than failing the whole diagnosis.
      if (!nodes.size || !(error instanceof QuotaStopped || quotaRefusal(error))) throw error;
      pending.unshift(next);
      stoppedBy = "quota";
      break;
    }
    nodes.set(key, dependencyFacts(item, repo));
    // completeNative throws unless both edge lists match their totals, so they are complete.
    meter.cover("issue", key, "complete");
    meter.cover(
      "labels",
      key,
      item.labels.pageInfo.hasNextPage ? "partial" : "complete",
      item.labels.pageInfo.hasNextPage ? { omission: "labels beyond the first 100" } : {},
    );
    meter.cover("native-blocked-by", key, "complete");
    meter.cover("native-blocking", key, "complete");
    for (const source of impact ? ["comments"] : ["comments", "linked-pull-requests"])
      meter.cover(source, key, "not-requested", {
        omission: "not read by a dependency report",
      });
    if (impact) {
      const linked = item.closedByPullRequestsReferences;
      meter.cover(
        "linked-pull-requests",
        key,
        !linked ? "failed" : linked.pageInfo.hasNextPage ? "partial" : "complete",
        !linked
          ? { failure: "missing" }
          : linked.pageInfo.hasNextPage
            ? { omission: "open closing PRs beyond the first 10" }
            : {},
      );
      direct = await readDependants(item, meter, query, signal);
      direct.subject = {
        ...direct.subject,
        createdAt: item.createdAt ?? null,
        closedByPullRequestsReferences: linked ?? null,
      };
    }
    if (tree)
      for (const ref of [...item.blockedBy.nodes, ...item.blocking.nodes])
        pending.push([ref.repository.nameWithOwner, ref.number]);
  }
  // Directed DFS over blocked-by edges: a reverse (blocking) relationship is not a cycle.
  const byUrl = new Map([...nodes.values()].map((node) => [node.url, node]));
  const cycles: string[][] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  function detect(url: string): void {
    const at = stack.indexOf(url);
    if (at >= 0) {
      cycles.push([...stack.slice(at), url]);
      return;
    }
    if (done.has(url)) return;
    stack.push(url);
    for (const ref of byUrl.get(url)?.upstream ?? []) detect(ref.url);
    stack.pop();
    done.add(url);
  }
  if (tree) for (const url of byUrl.keys()) detect(url);
  let treeBounds: TreeBounds | undefined;
  if (tree) {
    const notRead = new Map<string, { repository: string; number: number }>();
    for (const [repo, n] of pending) {
      const key = `${repo.toLowerCase()}#${n}`;
      if (nodes.has(key) || unfollowed.has(key) || notRead.has(key)) continue;
      notRead.set(key, { repository: repo, number: n });
      meter.cover("issue", key, "not-requested", {
        omission: stoppedBy === "quota" ? "not read: quota refusal" : "not read: tree node limit",
      });
    }
    // Unserved repositories (pdb serve, #373) leave the graph just as unread as a node cap does.
    const complete = stoppedBy === null && !notRead.size && !unfollowed.size;
    treeBounds = {
      complete,
      nodeLimit: maxNodes,
      nodesRead: nodes.size,
      stoppedBy,
      notRead: notRead.size,
      notServed: unfollowed.size,
      notReadSample: [...notRead.values()].slice(
        0,
        readProfiles["dependency-tree-v1"].bounds.notReadListed,
      ),
      cyclesComplete: complete,
    };
  }
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    tree,
    nodes: [...nodes.values()],
    cycles,
    guidance:
      "Native blockers are authoritative. Closed blockers do not prove behavior was delivered. Body drift is migration context only.",
    ...(unfollowed.size ? { unfollowed: [...unfollowed.values()] } : {}),
    collection: meter.collection(),
    ...(treeBounds ? { treeBounds } : {}),
    ...(direct ? { direct } : {}),
  };
}
/**
 * Whether a dependency report rests on incomplete evidence (exit 2 for every read command): a
 * tree that is not proven complete, a quota refusal, unread nodes or unknown native evidence.
 */
export function dependencyReportIncomplete(report: DependencyReport): boolean {
  if (report.tree && report.treeBounds?.complete !== true) return true;
  if (report.collection?.quota || report.collection?.notAttempted.length) return true;
  if (report.unfollowed?.length) return true;
  if (report.direct?.notRead.length || report.direct?.partial?.length) return true;
  // Any partial or failed source (truncated labels, partial dependant evidence) is incomplete.
  if (report.collection?.coverage.some((c) => c.state === "partial" || c.state === "failed"))
    return true;
  return report.nodes.some((node) => !node.known);
}
/** The open-issue inventory a `deps --top` answer ranks (dependency-discovery-v1, #196). */
export interface DependencyInventory {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  /** Open issues read, oldest first. Comments and bodies were not read. */
  issues: Issue[];
  /** False when the page cap or a quota refusal stopped the inventory early. */
  complete: boolean;
  /** Why the inventory is partial; null when complete. */
  stoppedBy: "page-limit" | "quota" | null;
  /** GitHub's open-issue count, when reported. */
  totalOpen: number | null;
  collection: ReadCollection;
}
/**
 * Read the repository's open issues for a direct-edge ranking: labels, creation time, open
 * closing-PR identities, native summaries and bounded direct edges with their summaries. Pages
 * oldest first with GitHub's cursor; stops at the profile's page cap or a quota refusal and
 * says so. Never reads discussion, reviews or transitive edges.
 */
export async function readDependencyInventory(
  repository: string,
  { signal, maxPages }: { signal?: AbortSignal; maxPages?: number } = {},
  query: Query = ghQueryWith(signal),
  now: () => Date = () => new Date(),
): Promise<DependencyInventory> {
  const bounds = readProfiles["dependency-discovery-v1"].bounds;
  const pageLimit = maxPages ?? bounds.pages;
  const startedAt = now().toISOString();
  const meter = new ReadMeter("dependency-discovery-v1", "deps-top", now, undefined, signal);
  const [owner, name] = repository.split("/");
  const fields = `number title url state stateReason createdAt updatedAt labels(first:${bounds.labels}){nodes{name} ${pageInfo}} closedByPullRequestsReferences(first:${bounds.linkedPullRequestsPerIssue},includeClosedPrs:false){nodes{number url state} ${pageInfo}} ${summaryFields} blockedBy(first:${bounds.blockedByPerIssue}){nodes{${nodeFields}} ${pageInfo}} blocking(first:${bounds.blockingPerIssue}){nodes{${nodeFields}} ${pageInfo}}`;
  const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:${bounds.pageSize},after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){totalCount nodes{${fields}} ${pageInfo}}}}`;
  const byUrl = new Map<string, Issue>();
  let cursor: string | undefined;
  let totalOpen: number | null = null;
  let stoppedBy: DependencyInventory["stoppedBy"] = null;
  for (let read = 0; ; read++) {
    if (read >= pageLimit) {
      stoppedBy = "page-limit";
      break;
    }
    signal?.throwIfAborted();
    let connection: unknown;
    try {
      const data = await meter.query(
        query,
        "open-issues",
        `${repository} page ${read + 1}`,
      )(source, { owner, name, ...(cursor ? { cursor } : {}) });
      connection = prop(data, "repository", "issues");
    } catch (error) {
      if (!byUrl.size || !(error instanceof QuotaStopped || quotaRefusal(error))) throw error;
      stoppedBy = "quota";
      break;
    }
    const nodes = prop(connection, "nodes");
    const info = prop(connection, "pageInfo");
    const total = prop(connection, "totalCount");
    if (typeof total === "number") totalOpen = total;
    if (!Array.isArray(nodes) || !isRecord(info)) throw new Error("Malformed GitHub connection.");
    for (const node of nodes) {
      const issue = selected<Issue>(node);
      if (issue)
        byUrl.set(issue.url, {
          ...issue,
          body: "",
          comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
        });
    }
    if (!info.hasNextPage) break;
    const next = info.endCursor;
    if (typeof next !== "string" || !next || next === cursor)
      throw new Error("GitHub pagination did not advance.");
    cursor = next;
  }
  const complete = stoppedBy === null;
  meter.cover(
    "open-issues",
    repository,
    complete ? "complete" : "partial",
    complete
      ? {}
      : {
          omission:
            stoppedBy === "quota"
              ? "stopped after a quota refusal"
              : `page cap ${pageLimit} × ${bounds.pageSize} reached`,
        },
  );
  meter.cover("comments", repository, "not-requested", {
    omission: "not read by a dependency ranking",
  });
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    issues: [...byUrl.values()],
    complete,
    stoppedBy,
    totalOpen,
    collection: meter.collection(),
  };
}
const dependantFields = (blockers: number) =>
  `number title url state stateReason createdAt repository{nameWithOwner} labels(first:100){nodes{name} ${pageInfo}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} ${pageInfo}} ${summaryFields} blockedBy(first:${blockers}){nodes{number url state stateReason} ${pageInfo}}`;
/**
 * Hydrate the eligibility facts of the open direct dependants for which `item` is the last open
 * blocker, in `blocking` order, batched and bounded (dependency-direct-v1). Dependants with other
 * open blockers need no hydration: their native summary already says they stay blocked. Those
 * beyond the bound, or not attempted after a quota refusal, are listed as not read.
 */
async function readDependants(
  item: DependencyIssue & KnownNative,
  meter: ReadMeter,
  query: Query,
  signal?: AbortSignal,
): Promise<DirectEvidence> {
  const bounds = readProfiles["dependency-direct-v1"].bounds;
  const evidence: DirectEvidence = {
    subject: {
      state: item.state,
      stateReason: item.stateReason ?? null,
      createdAt: null,
      closedByPullRequestsReferences: null,
      labels: item.labels,
    },
    dependants: [],
    notRead: [],
  };
  const seen = new Set<string>();
  const candidates = item.blocking.nodes.filter((node) => {
    if (seen.has(node.url)) return false;
    seen.add(node.url);
    return (
      item.state === "OPEN" &&
      node.state === "OPEN" &&
      node.issueDependenciesSummary?.blockedBy === 1
    );
  });
  const reading = candidates.slice(0, bounds.dependantsHydrated);
  for (const node of candidates.slice(bounds.dependantsHydrated))
    evidence.notRead.push({
      url: node.url,
      reason: `beyond the ${bounds.dependantsHydrated}-dependant bound`,
    });
  for (let at = 0; at < reading.length; at += bounds.dependantsPerRequest) {
    const batch = reading.slice(at, at + bounds.dependantsPerRequest);
    const subject = `${item.url} dependants ${at + 1}-${at + batch.length}`;
    const variables: Record<string, string | number> = {};
    const declared: string[] = [];
    const selections = batch.map((node, i) => {
      const [owner, name] = node.repository.nameWithOwner.split("/");
      Object.assign(variables, { [`o${i}`]: owner, [`r${i}`]: name, [`n${i}`]: node.number });
      declared.push(`$o${i}:String!,$r${i}:String!,$n${i}:Int!`);
      return `d${i}:repository(owner:$o${i},name:$r${i}){issue(number:$n${i}){${dependantFields(bounds.dependantBlockersListed)}}}`;
    });
    let data: unknown;
    try {
      signal?.throwIfAborted();
      data = await meter.query(
        query,
        "dependant-eligibility",
        subject,
      )(`query(${declared.join(",")}){${selections.join(" ")}}`, variables);
    } catch (error) {
      if (!(error instanceof QuotaStopped || quotaRefusal(error))) throw error;
      for (const node of reading.slice(at))
        evidence.notRead.push({ url: node.url, reason: "not attempted: GitHub quota refusal" });
      meter.cover("dependant-eligibility", item.url, "partial", {
        omission: "stopped after a quota refusal",
      });
      return evidence;
    }
    batch.forEach((node, i) => {
      const facts = selected<DependantFacts>(prop(data, `d${i}`, "issue"));
      if (facts) {
        evidence.dependants.push(facts);
        if (facts.blockedBy.pageInfo.hasNextPage)
          (evidence.partial ??= []).push({
            url: facts.url,
            reason: `blockers beyond the first ${bounds.dependantBlockersListed} not read`,
          });
        if (facts.labels.pageInfo.hasNextPage)
          (evidence.partial ??= []).push({
            url: facts.url,
            reason: `labels beyond the first ${bounds.labels} not read`,
          });
      } else evidence.notRead.push({ url: node.url, reason: "unavailable" });
    });
  }
  const gaps = evidence.notRead.length + (evidence.partial?.length ?? 0);
  meter.cover(
    "dependant-eligibility",
    item.url,
    gaps ? "partial" : "complete",
    gaps
      ? {
          omission: [
            ...(evidence.notRead.length
              ? [`${evidence.notRead.length} dependant(s) not read`]
              : []),
            ...(evidence.partial?.length
              ? [
                  `${evidence.partial.length} truncated dependant connection(s) (blockers or labels)`,
                ]
              : []),
          ].join("; "),
        }
      : {},
  );
  return evidence;
}
/** One line of read cost, from the report's own telemetry; unknown cost is never zero. */
export function readCostText(report: Pick<DependencyReport, "collection">): string {
  const t = report.collection?.telemetry;
  if (!t) return "Read cost: unknown (no telemetry).";
  return `Read cost: ${t.requests} request(s), ${t.bytes} bytes returned, GraphQL cost ${t.cost ?? `unknown (at least ${t.knownCost})`}, ${t.durationMs} ms.`;
}
/** Why a tree is incomplete, shared by the CLI, MCP and HTTP answers. */
export function treeIncompleteText(b: TreeBounds): string {
  const why = [
    ...(b.stoppedBy === "quota" ? ["stopped after a GitHub quota refusal"] : []),
    ...(b.stoppedBy === "node-limit" ? [`node limit ${b.nodeLimit}`] : []),
    ...(b.notServed ? [`${b.notServed} issue(s) in repositories not served`] : []),
  ].join("; ");
  return `TREE INCOMPLETE (${why || "unknown bound"}): read ${b.nodesRead} issue(s); ${b.notRead + (b.notServed ?? 0)} known issue(s) not read, and more not read beyond them. This is not a complete graph; cycles are only those among the issues read.`;
}
/** The reason given for a tree report that carries no bounds (an older schema or cache). */
export const legacyTreeText =
  "TREE COMPLETENESS UNKNOWN: this tree report records no bounds (older schema); treat it as incomplete and rerun deps N --tree.";
/** The listed identities a stopped tree did not read. */
export function notReadText(b: TreeBounds): string {
  const listed = b.notReadSample.map((r) => `${r.repository}#${r.number}`);
  return `  Not read: ${listed.join(", ")}${b.notRead > listed.length ? `, … ${b.notRead - listed.length} more` : ""}`;
}
/** The truncation notice of a stopped tree; empty for a complete tree or a direct read. */
export function treeNotice(report: Pick<DependencyReport, "treeBounds" | "tree">): string[] {
  const b = report.treeBounds;
  // A tree report without bounds (an older schema) is incomplete, and says why.
  if (!b) return report.tree ? [legacyTreeText] : [];
  if (b.complete)
    return [`Tree complete: ${b.nodesRead} issue(s) read (node limit ${b.nodeLimit}).`];
  return [treeIncompleteText(b), ...(b.notRead ? [notReadText(b)] : [])];
}
export function dependencyText(report: DependencyReport): string {
  return (
    [
      `Native issue dependencies: ${report.repository}`,
      `LIVE ${report.startedAt}–${report.fetchedAt}`,
      report.guidance,
      ...(report.tree
        ? [
            "--tree is an explicit, expensive diagnosis: at least one request per issue read, plus a request per further page of 100 edges. Routine questions use deps N.",
          ]
        : []),
      ...treeNotice(report),
      readCostText(report),
      ...report.nodes.flatMap((node) => [
        `\n#${node.number} ${node.title} ${node.url}`,
        node.verdict,
        ...node.upstream.map((n) => `  Upstream: ${n.url} ${n.state}/${n.stateReason ?? ""}`),
        ...node.downstream.map(
          (n) => `  Downstream: ${n.url}${n.lastOpenBlocker ? " — last open blocker" : ""}`,
        ),
        ...node.drift.map((n) => `  Drift: ${n.url} — text only; not yet migrated`),
      ]),
      ...report.cycles.map((path) => `CYCLE: ${path.join(" -> ")}`),
    ].join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// deps add / deps remove: validated dependency changes.
// Contract: doc/issue-dependencies.md, "deps add and deps remove" and
// "Rules for commands that change tickets".

/** The only GitHub write boundary: `gh` with explicit arguments, never a shell. */
export type GhRun = (args: string[], call?: CommentCallOptions) => Promise<void>;
/** Build a guarded `gh` runner over an explicit GH transport, environment and query (#919). */
export const ghRunOver =
  (transport: GhTransport, env?: NodeJS.ProcessEnv, query?: Query): GhRun =>
  async (args, call) => {
    // Workflow comments go through the shared bounded recovery boundary (#345).
    if (commentCommand(args)) {
      const resolvedQuery = query ?? ghQuery;
      const runComment =
        transport === execFileTransport && !env && resolvedQuery === ghQuery
          ? ghCommentRun
          : withCommentRecovery({
              dispatch: commentPostOver(transport, env),
              readBack: (target, since) => ghCommentReceipt(target, since, resolvedQuery),
            });
      await runComment(args, call);
      return;
    }
    const outcome = await transport({
      args,
      ...(env ? { env } : {}),
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
    });
    if (!outcome.ok) {
      // Keep only a rate-limit discriminator; never echo arguments, stderr or response bodies.
      if (isRateLimit(`${outcome.stderr}\n${outcome.stdout}`))
        throw new RateLimitError(`gh ${args[0]} ${args[1]} was rate limited by GitHub.`);
      throw new Error(`gh ${args[0]} ${args[1]} failed. Check gh auth status and rate limits.`);
    }
  };
export const ghRun: GhRun = ghRunOver(execFileTransport);
/**
 * One REST comment POST through gh with `--include`, so the refusal is classified from that same
 * response's status, headers and error fields (#293, #345). Resolves with the created URL.
 */
/**
 * One comment POST over a GH transport (#918): `POST /repos/{r}/issues/{n}/comments` with the
 * frozen body, classified from this response. Runs with the given environment, so a service's
 * host and transport are honoured for writes as for reads.
 */
export const commentPostOver =
  (transport: GhTransport, env?: NodeJS.ProcessEnv) =>
  async (args: string[]): Promise<{ url: string | null }> => {
    const target = commentCommand(args)!;
    const outcome = await transport({
      args: [
        "api",
        "--include",
        "--method",
        "POST",
        `repos/${target.repository}/issues/${target.number}/comments`,
        "-f",
        `body=${target.body}`,
      ],
      ...(env ? { env } : {}),
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
    });
    if (!outcome.ok) {
      let response: GhResponse | null = null;
      try {
        response = outcome.stdout ? parseGhResponse(outcome.stdout) : null;
      } catch {
        response = null;
      }
      throw Object.assign(new Error("gh issue comment failed."), {
        commentAttempt: classifyCommentResponse(response, {
          exitCode: outcome.exitCode,
          timedOut: outcome.kind === "timeout",
        }),
      });
    }
    const stdout = outcome.stdout;
    let url: unknown = null;
    try {
      url = prop(JSON.parse(parseGhResponse(stdout).body), "html_url");
    } catch {
      url = null;
    }
    if (typeof url === "string") return { url };
    // A 2xx without a readable comment identity is acceptance-unknown, not confirmed: recovery
    // must read back the receipt and must not re-post (doc/design/comment-write-recovery.md).
    throw Object.assign(new Error("gh issue comment answered without a readable comment."), {
      commentAttempt: {
        kind: "unknown",
        message: "GitHub answered without a readable comment URL; acceptance is unknown.",
      },
    });
  };
const ghCommentPost = commentPostOver(execFileTransport);

/**
 * Read back the newest comments on the target for this exact frozen body written by the
 * authenticated viewer. Another author's copy, a substring or another ticket never counts.
 */
export async function ghCommentReceipt(
  target: { repository: string; number: number; body: string },
  since: Date,
  query: Query = ghQuery,
): Promise<CommentReceipt> {
  const [owner, name] = target.repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(last:100){pageInfo{hasPreviousPage} nodes{url body viewerDidAuthor createdAt}}} ... on PullRequest{comments(last:100){pageInfo{hasPreviousPage} nodes{url body viewerDidAuthor createdAt}}}}}}`,
    { owner: owner ?? "", name: name ?? "", number: target.number },
  );
  // Issues and pull requests share the comment list; either kind of target is read.
  const comments = prop(data, "repository", "issueOrPullRequest", "comments");
  const nodes = prop(comments, "nodes");
  if (!Array.isArray(nodes)) return { status: "unreadable" };
  const matches = nodes.filter(
    (n) =>
      prop(n, "viewerDidAuthor") === true &&
      // Bound to this attempt: created no earlier than its first dispatch (allowing 5s of
      // clock skew), so an identical earlier comment never counts as this write's receipt.
      Date.parse(String(prop(n, "createdAt"))) >= since.getTime() - RECEIPT_SKEW_MS &&
      typeof prop(n, "body") === "string" &&
      sameCommentBody(prop(n, "body") as string, target.body),
  );
  if (matches.length > 1) return { status: "duplicate", count: matches.length };
  if (matches.length === 1) {
    const url = prop(matches[0], "url");
    return { status: "found", url: typeof url === "string" ? url : null };
  }
  // A just-sent comment is among the newest 100; older history is irrelevant to this receipt.
  return { status: "absent" };
}

const RECEIPT_SKEW_MS = 5_000;

/** Production comment boundary: bounded recovery over the REST POST and its read-back. */
export const ghCommentRun = withCommentRecovery({
  dispatch: ghCommentPost,
  readBack: ghCommentReceipt,
});

/** A write refused because of a GitHub (secondary) rate limit: stop all further writes. */
import type { FailureClassification } from "./evidence.js";

export class RateLimitError extends Error {
  rateLimited = true;
  /**
   * Sanitized retry metadata only: seconds from GitHub's retry-after hint and/or the ISO
   * time the quota resets. Never carries tokens, arguments or raw response bodies.
   */
  constructor(
    message: string,
    readonly retry: { retryAfterSeconds?: number | null; resetAt?: string | null } = {},
    /**
     * Same-response evidence (#293): category, quota consistency and the allowlisted headers of
     * the refused response. Absent when gh printed no headers.
     */
    readonly evidence?: FailureClassification,
  ) {
    super(message);
  }
}
export const isRateLimit = (text: string): boolean =>
  /rate limit|abuse detection|HTTP 429|retry-after/i.test(text);

type Blocker =
  | { __typename: "Issue"; number: number; url: string; state: string }
  | {
      __typename: "PullRequest";
      number: number;
      url: string;
      closingIssuesReferences?: { nodes: { number: number }[] } | null;
    };
/** Resolve a proposed blocker: an issue, a pull request (refused), or missing. */
async function readBlocker(
  repository: string,
  number: number,
  query: Query,
): Promise<Blocker | null> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state} ... on PullRequest{number url closingIssuesReferences(first:20){nodes{number}}}}}}`,
    { owner, name, number },
  );
  return selected<Blocker>(prop(data, "repository", "issueOrPullRequest"));
}

/**
 * Live upstream walk from `from`: does following blocked-by edges reach `target`?
 * If so, making `target` blocked by `from` would close a cycle.
 * @returns {Promise<string[] | null>} the path from `from` to `target`, or null.
 */
async function upstreamPath(
  repository: string,
  from: number,
  targetUrl: string,
  query: Query,
): Promise<string[] | null> {
  const seen = new Set<string>();
  const pending: [string, number, string[]][] = [[repository, from, []]];
  for (let next = pending.shift(); next; next = pending.shift()) {
    const [repo, n, path] = next;
    const item = await readDependencyIssue(repo, n, query);
    const here = [...path, item.url];
    if (item.url === targetUrl) return here;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    for (const ref of item.blockedBy.nodes)
      pending.push([ref.repository.nameWithOwner, ref.number, here]);
  }
  return null;
}

/** The one explanatory comment posted on a changed ticket. */
export type DependencyAction = "add" | "remove";
export function commentFor(action: DependencyAction, blockers: number[], note: string): string {
  const verb = action === "add" ? "Added" : "Removed";
  const noun = blockers.length === 1 ? "dependency" : "dependencies";
  return `${verb} native blocked-by ${noun}: ${blockers.map((n) => `#${n}`).join(", ")}.\n\nWhy: ${note}\n\nRecorded with \`pdb deps ${action}\`; labels are unchanged (doc/issue-dependencies.md).`;
}

export type ChangeStatus = "apply" | "refused" | "noop" | "done" | "failed" | "skipped";
export interface DependencyChange {
  blocker: number;
  url: string | null;
  status: ChangeStatus;
  reason: string;
  command: string[] | null;
}
export interface DependencyRequest {
  action: DependencyAction;
  number: number;
  on: number[];
  note: string;
}
export interface DependencyPlan {
  schemaVersion: 1;
  repository: string;
  action: DependencyAction;
  target: { number: number; url: string; title: string };
  note: string;
  changes: DependencyChange[];
  comment: string | null;
  commentCommand: string[] | null;
}
export interface DependencyChangeResult extends DependencyPlan {
  dryRun: false;
  commentStatus: string;
  rateLimited: boolean;
  exitCode: number;
}
/** Plan a dependency change from fresh live reads. Changes nothing. */
export async function planDependencyChange(
  repository: string,
  request: DependencyRequest,
  query: Query = ghQuery,
): Promise<DependencyPlan> {
  const { action, number, note } = request;
  const target = await readDependencyIssue(repository, number, query);
  // --on numbers name issues in this repository; ignore same-numbered cross-repository blockers.
  const existing = new Set(
    target.blockedBy.nodes
      // GitHub repository names are case-insensitive; --repo may differ from nameWithOwner.
      .filter((n) => n.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase())
      .map((n) => n.number),
  );
  const flag = action === "add" ? "--add-blocked-by" : "--remove-blocked-by";
  const changes: DependencyChange[] = [];
  for (const on of new Set(request.on)) {
    const change: DependencyChange = {
      blocker: on,
      url: null,
      status: "apply",
      reason: "",
      command: null,
    };
    changes.push(change);
    if (on === number) {
      Object.assign(change, { status: "refused", reason: "A ticket cannot depend on itself." });
      continue;
    }
    if (action === "remove") {
      change.url = `https://github.com/${repository}/issues/${on}`;
      if (!existing.has(on))
        Object.assign(change, {
          status: "noop",
          reason: "Not a native blocker; nothing to remove.",
        });
    } else {
      const blocker = await readBlocker(repository, on, query);
      if (!blocker) {
        Object.assign(change, { status: "refused", reason: `#${on} does not exist.` });
        continue;
      }
      change.url = blocker.url;
      if (blocker.__typename === "PullRequest") {
        const closes = (blocker.closingIssuesReferences?.nodes ?? []).map((n) => `#${n.number}`);
        Object.assign(change, {
          status: "refused",
          reason: `#${on} is a pull request and cannot be a blocker; name the issue it closes instead${closes.length ? ` (${closes.join(", ")})` : ""}.`,
        });
        continue;
      }
      if (existing.has(on)) {
        Object.assign(change, { status: "noop", reason: "Already a native blocker." });
        continue;
      }
      const cycle = await upstreamPath(repository, on, target.url, query);
      if (cycle) {
        Object.assign(change, {
          status: "refused",
          reason: `Would create a cycle: ${[target.url, ...cycle].join(" -> ")}`,
        });
        continue;
      }
    }
    if (change.status === "apply")
      change.command = ["issue", "edit", String(number), "--repo", repository, flag, String(on)];
  }
  const applying = changes.filter((c) => c.status === "apply").map((c) => c.blocker);
  const comment = applying.length ? commentFor(action, applying, note) : null;
  return {
    schemaVersion: 1,
    repository,
    action,
    target: { number: target.number, url: target.url, title: target.title },
    note,
    changes,
    comment,
    commentCommand: comment
      ? ["issue", "comment", String(number), "--repo", repository, "--body", comment]
      : null,
  };
}

/**
 * Apply a plan one edge at a time, then post one explanatory comment.
 * Exit codes follow the shared rules: 0 all done, 2 partly done, 1 nothing done.
 */
export async function applyDependencyChange(
  plan: DependencyPlan,
  run: GhRun = ghRun,
): Promise<DependencyChangeResult> {
  const results = plan.changes.map((c) => ({ ...c }));
  const applied: DependencyChange[] = [];
  let rateLimited = false;
  for (const change of results.filter((c) => c.status === "apply")) {
    if (rateLimited) {
      // The shared rules stop on a rate limit rather than pressing on.
      Object.assign(change, {
        status: "skipped",
        reason: "Not attempted: stopped after a rate limit.",
      });
      continue;
    }
    try {
      // A planned "apply" change always carries its command.
      await run(change.command ?? []);
      change.status = "done";
      applied.push(change);
    } catch (error) {
      rateLimited = !!prop(error, "rateLimited");
      Object.assign(change, { status: "failed", reason: prop(error, "message") });
    }
  }
  // The comment names only what actually changed, and is what the result reports.
  const comment = applied.length
    ? commentFor(
        plan.action,
        applied.map((c) => c.blocker),
        plan.note,
      )
    : null;
  const commentCommand = comment
    ? ["issue", "comment", String(plan.target.number), "--repo", plan.repository, "--body", comment]
    : null;
  let commentStatus = "none";
  if (commentCommand && rateLimited) commentStatus = "skipped: stopped after a rate limit";
  else if (commentCommand)
    try {
      await run(commentCommand);
      commentStatus = "posted";
    } catch (error) {
      // A comment write's bounded recovery says what happened and when to retry (#345).
      const recovery = prop(error, "recovery");
      commentStatus = isRecord(recovery)
        ? `${recovery.acceptance === "unknown" ? "unknown" : "failed"}: ${String(recovery.message)}`
        : prop(error, "rateLimited")
          ? "failed: rate limited"
          : "failed";
    }
  const unfinished = results.some((c) => c.status !== "done" && c.status !== "noop");
  const exitCode = !applied.length
    ? unfinished
      ? 1
      : 0
    : unfinished || commentStatus !== "posted"
      ? 2
      : 0;
  return {
    ...plan,
    dryRun: false,
    changes: results,
    comment,
    commentCommand,
    commentStatus,
    rateLimited,
    exitCode,
  };
}

/** Text rendering shared by dry runs and applied results. */
export function dependencyChangeText(
  result: DependencyPlan & { dryRun: boolean; commentStatus?: string },
): string {
  const lines = [
    `deps ${result.action}: #${result.target.number} ${result.target.title} ${result.target.url}`,
    result.dryRun ? "DRY RUN: no changes made." : "",
  ];
  for (const c of result.changes) {
    const shown = c.command && result.dryRun ? `  gh ${c.command.join(" ")}` : "";
    lines.push(`- #${c.blocker}: ${c.status}${c.reason ? ` — ${c.reason}` : ""}`);
    if (shown) lines.push(shown);
  }
  if (result.comment)
    lines.push(
      result.dryRun
        ? `Comment that would be posted on #${result.target.number}:\n${result.comment}`
        : `Comment: ${result.commentStatus}`,
    );
  return lines.filter(Boolean).join("\n") + "\n";
}
