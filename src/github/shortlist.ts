/**
 * Routine briefing collection (#368, profile briefing-shortlist-v1): discover every open issue
 * and pull request cheaply, rank them through the briefing's own engine, then hydrate only the
 * subjects the briefing would show and the items their rules need. Contract:
 * doc/design/collection-profiles.md, "Command read plans" and "Ranking before limiting".
 *
 * Discovery facts (labels, creation time, native summaries and direct edges, closing links, PR
 * head/base/draft) are real evidence. Bodies, comments, reviews, threads and checks are not read
 * for an item that was not hydrated: such an item is kept only as a ranking candidate, recorded
 * `not-requested`, listed in `shortlist.notHydrated` and never shown as a subject. Its unread
 * evidence is unknown, never empty.
 */
import { completeNative, nativeFields } from "./dependencies.js";
import {
  closedBy,
  comment,
  common,
  ghQueryWith,
  ghRestWith,
  hydratePullRequests,
  info,
  pages,
  prop,
  selected,
} from "./github.js";
import type { Query, QueryVariables, Rest } from "./github.js";
import type { ReadCollection, ReadSourceCoverage } from "./readplan.js";
import { hydrate, quotaRefusal, ReadMeter, readProfiles } from "./readplan.js";
import { hydrateRequiredChecks } from "./requiredchecks.js";
import type { Comment, Issue, Page, PullRequest, Snapshot } from "./types.js";

export type ShortlistBounds = { -readonly [K in keyof Profile["bounds"]]: number };
type Profile = (typeof readProfiles)["briefing-shortlist-v1"];

/** Why a discovered item was not hydrated. */
/**
 * `unavailable`: the read answered without the item (null, malformed or partial), which may be a
 * deletion, a transfer, a permission change or a transient error; unknown, never closed.
 */
export type NotHydratedReason =
  | "not-shortlisted"
  | "hydration-cap"
  | "failed"
  | "not-attempted"
  | "unavailable";
/** The shortlist record a routine snapshot carries (additive; snapshot schema unchanged). */
export interface ShortlistRecord {
  schemaVersion: 1;
  profile: "briefing-shortlist-v1";
  discovered: { issues: number; pullRequests: number; complete: boolean };
  /** URLs whose full snapshot fields were read, in hydration order. */
  hydrated: string[];
  /** Discovered open items whose comments, reviews, checks and records were not read. */
  notHydrated: {
    number: number;
    url: string;
    kind: "issue" | "pull-request";
    reason: NotHydratedReason;
  }[];
  /** Ranking rounds run (each re-ranks after hydration). */
  rounds: number;
  /** True when any open item was not hydrated: the ordering cannot be proven final. */
  provisional: boolean;
  /** The omission notice (count and how to inspect), or null when every item was hydrated. */
  notice: string | null;
}

/** Whole bounded discovery results, never individual GraphQL pages or projections. */
export interface DiscoveryFacts {
  nodes: (Issue | PullRequest)[];
  complete: boolean;
  observedAt: string;
  omission: string | null;
}
export interface DiscoveryRequest {
  repository: string;
  source: "issues" | "pullRequests";
  pageSize: number;
  pages: number;
}
export type DiscoveryReader = (
  request: DiscoveryRequest,
  read: (query: Query, signal?: AbortSignal) => Promise<DiscoveryFacts>,
  signal?: AbortSignal,
) => Promise<DiscoveryFacts>;

/** Complete selected issue records (including all their comment/native pages), not pages. */
export interface IssueFacts {
  issues: Issue[];
  gone: string[];
  unavailable: [string, NotHydratedReason][];
  coverage: ReadSourceCoverage[];
  quota: ReadCollection["quota"];
  notAttempted: string[];
  warnings: string[];
  complete: boolean;
}
export type IssueFactReader = (
  request: { repository: string; numbers: number[]; issuesPerRequest: number; concurrency: number },
  read: (query: Query, signal?: AbortSignal, numbers?: readonly number[]) => Promise<IssueFacts>,
  signal?: AbortSignal,
) => Promise<IssueFacts>;

export interface ShortlistOptions {
  /**
   * Rank a snapshot through the briefing engine and return the URLs it would show (its
   * subjects), most important first. Called once per round; it must not read GitHub.
   */
  select: (snapshot: Snapshot) => Promise<string[]>;
  /** Optional whole-fact cache; selection and all hydration remain per caller. */
  discovery?: DiscoveryReader;
  /** Cache only complete whole selected records under their distinct hydration coverage. */
  issueFacts?: IssueFactReader;
  signal?: AbortSignal;
  /** REST boundary for required-check evidence (#343); absent leaves requiredness unknown. */
  rest?: Rest;
  /** Smaller bounds for tests; effective values are reported in the collection record. */
  bounds?: Partial<ShortlistBounds>;
  monotonic?: () => number;
  /**
   * The read's shared meter, when the caller also reads through it (permission lookups,
   * delivery evidence): one quota stop and one telemetry record for the whole command.
   */
  meter?: ReadMeter;
}

const emptyPage = <T>(): Page<T> => ({
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
});
const labelsField = `labels(first:100){nodes{name} ${info}}`;
/** Discovery fields: no body, comments, reviews, threads or checks. */
export const discoveryIssueFields = `number title url state stateReason createdAt updatedAt ${labelsField} ${closedBy} ${nativeFields}`;
/**
 * Issues whose comments mention a PR leave a cross-reference on it; delivery and responsibility
 * records about a PR live on such an issue even without a closing link (#368).
 */
const crossReferences = `timelineItems(first:25,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{__typename ... on Issue{number url state}}}} ${info}}`;
export const discoveryPullRequestFields = `number title url state createdAt updatedAt ${labelsField} headRefOid headRefName baseRefName isDraft closingIssuesReferences(first:100){nodes{number url} ${info}} ${crossReferences}`;
const hydratedIssueFields = `${common} stateReason ${closedBy} ${nativeFields}`;

/**
 * A ranking candidate built from discovery facts only. Its unread sources are empty here so the
 * engine can run; they are never shown, because a stub is never a subject of the result.
 */
const issueStub = (node: Issue): Issue => ({ ...node, body: "", comments: emptyPage<Comment>() });
const pullRequestStub = (node: PullRequest): PullRequest => ({
  ...issueStub(node),
  headRefOid: node.headRefOid,
  headRefName: node.headRefName,
  baseRefName: node.baseRefName,
  isDraft: node.isDraft,
  closingIssuesReferences: node.closingIssuesReferences,
  mergeable: "UNKNOWN",
  mergeStateStatus: "UNKNOWN",
  reviewDecision: null,
  reviewThreads: emptyPage(),
  reviews: emptyPage(),
  commits: { nodes: [] },
});

/** A malformed inventory record cannot be reused as complete discovery. */
const unreadableDiscovery = (node: unknown): boolean =>
  typeof prop(node, "number") !== "number" ||
  typeof prop(node, "url") !== "string" ||
  typeof prop(node, "labels", "pageInfo", "hasNextPage") !== "boolean";

export async function collectShortlist(
  repository: string,
  options: ShortlistOptions,
  injected?: Query,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const { signal } = options;
  const bounds: ShortlistBounds = {
    ...readProfiles["briefing-shortlist-v1"].bounds,
    ...options.bounds,
  };
  const meter =
    options.meter ??
    new ReadMeter("briefing-shortlist-v1", "briefing", now, options.monotonic, signal);
  const base = injected ?? ghQueryWith(signal, { operation: "snapshot" });
  const startedAt = now().toISOString();
  const [owner, name] = repository.split("/");
  const warnings: string[] = [];
  const read = async (
    q: Query,
    source: string,
    variables: QueryVariables = {},
    activeSignal = signal,
  ) => {
    activeSignal?.throwIfAborted();
    const data = await q(source, { owner, name, ...variables });
    if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
    return data.repository;
  };

  // 1. Discovery: each whole connection result is independently cacheable. No page cache.
  const discover = async (field: "issues" | "pullRequests", fields: string) => {
    const label = field === "issues" ? "open-issues" : "open-pull-requests";
    const produce = async (
      baseQuery: Query,
      activeSignal?: AbortSignal,
    ): Promise<DiscoveryFacts> => {
      const q = meter.query(baseQuery, label, repository);
      const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:${bounds.pageSize},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC},states:OPEN){nodes{${fields}} ${info}}}}`;
      let count = 0;
      let more = false;
      const nodes = await pages<Issue | PullRequest>(
        async (cursor) => {
          activeSignal?.throwIfAborted();
          const data = await q(source, { owner, name, ...(cursor ? { cursor } : {}) });
          if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
          const page = prop(data.repository, field);
          count++;
          more = prop(page, "pageInfo", "hasNextPage") === true;
          return page;
        },
        () => count >= bounds.pages,
      );
      return {
        nodes,
        complete:
          !more &&
          nodes.every(
            (node) =>
              !unreadableDiscovery(node) &&
              (field === "issues" ||
                typeof prop(node, "closingIssuesReferences", "pageInfo", "hasNextPage") ===
                  "boolean"),
          ),
        observedAt: now().toISOString(),
        omission: more
          ? `open ${field === "issues" ? "issues" : "pull requests"} beyond ${nodes.length} (${bounds.pages} pages of ${bounds.pageSize}) not discovered`
          : null,
      };
    };
    const facts = options.discovery
      ? await options.discovery(
          { repository, source: field, pageSize: bounds.pageSize, pages: bounds.pages },
          produce,
          signal,
        )
      : await produce(base, signal);
    // Discovery nodes are mutated during candidate preparation; cache values stay immutable.
    const copy = structuredClone(facts);
    meter.cover(label, repository, copy.complete ? "complete" : "partial", {
      observedAt: copy.observedAt,
      omission: copy.omission,
    });
    if (copy.omission)
      warnings.push(`Discovery incomplete: ${copy.omission}; they are unknown, not absent.`);
    return copy;
  };
  const [issueInventory, prInventory] = await Promise.all([
    discover("issues", discoveryIssueFields),
    discover("pullRequests", discoveryPullRequestFields),
  ]);
  const stubs = new Map<string, Issue | PullRequest>();
  const kinds = new Map<string, "issue" | "pull-request">();
  let unreadableNodes = 0;
  const readable = <T>(nodes: T[]): T[] =>
    nodes.filter((node) => {
      if (!unreadableDiscovery(node)) return true;
      unreadableNodes++;
      return false;
    });
  issueInventory.nodes = readable(issueInventory.nodes);
  prInventory.nodes = readable(prInventory.nodes).filter((node) => {
    if (typeof prop(node, "closingIssuesReferences", "pageInfo", "hasNextPage") === "boolean")
      return true;
    unreadableNodes++;
    return false;
  });
  if (unreadableNodes) {
    issueInventory.complete = false;
    warnings.push(
      `Discovery returned ${unreadableNodes} open item(s) without their identity, labels or closing links; they are unknown, not absent.`,
    );
  }
  for (const node of issueInventory.nodes) {
    stubs.set(node.url, issueStub(node));
    kinds.set(node.url, "issue");
  }
  /** Open issues that mention each PR (record candidates), and whether that list is whole. */
  const referencedBy = new Map<string, string[]>();
  for (const node of prInventory.nodes) {
    const timeline = prop(node, "timelineItems");
    delete (node as { timelineItems?: unknown }).timelineItems;
    stubs.set(node.url, pullRequestStub(node as PullRequest));
    kinds.set(node.url, "pull-request");
    const sources = (prop(timeline, "nodes") as unknown[] | undefined) ?? [];
    // A mention whose source could not be read (null: no access, deleted) may hold a record.
    if (sources.some((event) => !prop(event, "source")))
      warnings.push(
        `${node.url}: an item that mentions it could not be read; delivery and responsibility records there are unknown.`,
      );
    referencedBy.set(
      node.url,
      sources
        .map((event) => prop(event, "source"))
        .filter(
          (source) => prop(source, "__typename") === "Issue" && prop(source, "state") === "OPEN",
        )
        .map((source) => String(prop(source, "url"))),
    );
    if (!timeline || prop(timeline, "pageInfo", "hasNextPage") !== false)
      warnings.push(
        `${node.url}: more issues mention it than were listed; delivery and responsibility records on the rest are unknown.`,
      );
  }
  const order = [...stubs.keys()];

  const hydratedIssues = new Map<string, Issue>();
  const hydratedPrs = new Map<string, PullRequest>();
  /** Items read but now closed (no longer in the open population) or unreadable. */
  const gone = new Set<string>();
  const unhydratable = new Map<string, NotHydratedReason>();
  const hydratedOrder: string[] = [];
  const isHydrated = (url: string) => hydratedIssues.has(url) || hydratedPrs.has(url);

  const build = (): Snapshot => {
    const issues: Issue[] = [];
    const pullRequests: PullRequest[] = [];
    for (const url of order) {
      if (gone.has(url)) continue;
      const kind = kinds.get(url);
      const item = hydratedIssues.get(url) ?? hydratedPrs.get(url);
      // A stub that could not be hydrated but would be shown is withdrawn rather than shown.
      if (!item && unhydratable.has(url)) continue;
      const value = item ?? stubs.get(url)!;
      if (kind === "issue") issues.push(value as Issue);
      else pullRequests.push(value as PullRequest);
    }
    return {
      schemaVersion: 1,
      repository,
      startedAt,
      fetchedAt: now().toISOString(),
      issues,
      pullRequests,
      dependencies: [
        ...new Map(
          issues
            .flatMap((item) => item.blockedBy?.nodes ?? [])
            .map((item) => [
              item.url,
              { ...item, available: true, repository: item.repository.nameWithOwner },
            ]),
        ).values(),
      ],
      changed: [],
      since: null,
      warnings: [...warnings],
      rateLimit: null,
    };
  };

  /**
   * Closing links both ways, and the open issues that mention a shown PR (where its delivery and
   * responsibility records live): a subject's rules read the items it is linked to.
   */
  const needed = (subjects: string[]): string[] => [...new Set(units(subjects).flat())];
  /** The discovered items one item links to, from its hydrated facts when it has them. */
  const linksOf = (url: string): string[] => {
    const prefix = `https://github.com/${repository}/`.toLowerCase();
    const item = hydratedIssues.get(url) ?? hydratedPrs.get(url) ?? stubs.get(url);
    if (!item) return [];
    const links: string[] =
      kinds.get(url) === "pull-request"
        ? [
            ...(item as PullRequest).closingIssuesReferences.nodes.map((ref) => ref.url),
            ...(referencedBy.get(url) ?? []),
          ]
        : (item.closedByPullRequestsReferences?.nodes ?? [])
            .filter((ref) => ref.state === "OPEN")
            .map((ref) => ref.url);
    return links.filter((link) => link.toLowerCase().startsWith(prefix) && stubs.has(link));
  };
  /**
   * An item with everything it links to, transitively: one hydration unit. A PR's own-work and
   * delivery facts come through its linked issues, so a unit is read whole or not at all, and
   * overlapping units resolve to their union.
   */
  const closureOf = (url: string): string[] => {
    const seen = new Set<string>([url]);
    const queue = [url];
    while (queue.length)
      for (const link of linksOf(queue.shift()!))
        if (!seen.has(link) && !gone.has(link)) {
          seen.add(link);
          queue.push(link);
        }
    return [...seen];
  };
  const units = (subjects: string[]): string[][] =>
    subjects.filter((url) => stubs.has(url)).map(closureOf);
  /**
   * Withdraw every hydrated item whose unit is not wholly hydrated (a link was capped, failed,
   * withdrawn or, once rounds end, never read): its rules would otherwise run without linked
   * evidence. Returns whether anything was withdrawn; repeats until stable.
   */
  const withdrawIncomplete = (final: boolean): boolean => {
    let changed = false;
    for (let again = true; again;) {
      again = false;
      for (const url of [...hydratedOrder]) {
        const missing = closureOf(url).some(
          (member) =>
            !isHydrated(member) && !gone.has(member) && (final || unhydratable.has(member)),
        );
        if (!missing) continue;
        hydratedIssues.delete(url);
        hydratedPrs.delete(url);
        hydratedOrder.splice(hydratedOrder.indexOf(url), 1);
        if (!unhydratable.has(url)) unhydratable.set(url, "hydration-cap");
        again = changed = true;
      }
    }
    return changed;
  };

  const commentsSource = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}`;
  const loadIssues = async (urls: string[], baseQuery = base, activeSignal = signal) => {
    const batches: string[][] = [];
    for (let i = 0; i < urls.length; i += bounds.issuesPerRequest)
      batches.push(urls.slice(i, i + bounds.issuesPerRequest));
    const outcomes = await hydrate(
      batches,
      async (batch) => {
        const numbers = batch.map((url) => stubs.get(url)!.number);
        const q = meter.query(baseQuery, "issue", `${repository}#${numbers.join(",")}`);
        const declared = numbers.map((_, i) => `$n${i}:Int!`).join(",");
        const fields = numbers
          .map((_, i) => `i${i}:issue(number:$n${i}){${hydratedIssueFields}}`)
          .join(" ");
        const repo = await read(
          q,
          `query($owner:String!,$name:String!,${declared}){repository(owner:$owner,name:$name){${fields}}}`,
          Object.fromEntries(numbers.map((n, i) => [`n${i}`, n])),
          activeSignal,
        );
        return numbers.map((_, i) => selected<Issue>(prop(repo, `i${i}`)));
      },
      { concurrency: bounds.hydrationConcurrency, signal: activeSignal },
    );
    for (const [b, outcome] of outcomes.entries()) {
      for (const [i, url] of batches[b].entries()) {
        const subject = `${repository}#${stubs.get(url)!.number}`;
        if (outcome.state !== "done") {
          const reason = outcome.state === "failed" ? "failed" : "not-attempted";
          unhydratable.set(url, reason);
          const failure =
            outcome.state === "failed"
              ? quotaRefusal(outcome.error)
                ? "rate-limited"
                : "read-failed"
              : null;
          if (failure) meter.cover("issue", subject, "failed", { failure });
          else {
            meter.notAttempted.push(url);
            meter.cover("issue", subject, "not-requested", {
              omission: "not attempted after a quota refusal",
            });
          }
          continue;
        }
        const issue = outcome.value[i];
        // A null or malformed answer is unknown (deleted, transferred, no access, transient),
        // never "closed": not shown, disclosed, and a completeness warning.
        if (
          !issue ||
          typeof issue.state !== "string" ||
          typeof prop(issue, "comments", "pageInfo", "hasNextPage") !== "boolean" ||
          typeof prop(issue, "labels", "pageInfo", "hasNextPage") !== "boolean"
        ) {
          unhydratable.set(url, "unavailable");
          meter.cover("issue", subject, "failed", { failure: "unavailable" });
          continue;
        }
        if (issue.state !== "OPEN") {
          // Explicitly closed since discovery: no longer open work.
          gone.add(url);
          meter.cover("issue", subject, "complete");
          continue;
        }
        try {
          if (issue.comments.pageInfo.hasNextPage) {
            const q = meter.query(baseQuery, "comments", subject);
            const initial = issue.comments;
            issue.comments.nodes = await pages<Comment>(async (cursor) => {
              if (!cursor) return initial;
              return prop(
                await read(q, commentsSource, { number: issue.number, cursor }, activeSignal),
                "issue",
                "comments",
              );
            });
            issue.comments.pageInfo = { hasNextPage: false, endCursor: null };
          }
        } catch (error) {
          activeSignal?.throwIfAborted();
          unhydratable.set(url, quotaRefusal(error) ? "not-attempted" : "failed");
          meter.cover("comments", subject, "failed", {
            failure: quotaRefusal(error) ? "rate-limited" : "read-failed",
          });
          continue;
        }
        try {
          await completeNative(
            issue,
            repository,
            meter.query(baseQuery, "native-blocked-by", subject),
          );
        } catch (error) {
          activeSignal?.throwIfAborted();
          // Unknown edges are never "no blockers".
          delete issue.issueDependenciesSummary;
          delete issue.blockedBy;
          delete issue.blocking;
          warnings.push(`${issue.url}: native dependencies could not be read; unknown.`);
          meter.cover("native-blocked-by", subject, "failed", {
            failure: quotaRefusal(error) ? "rate-limited" : "read-failed",
          });
        }
        if (issue.labels.pageInfo.hasNextPage)
          warnings.push(`${issue.url}: labels exceed 100; label analysis incomplete.`);
        hydratedIssues.set(url, issue);
        hydratedOrder.push(url);
        meter.cover("issue", subject, "complete");
      }
    }
  };
  const hydrateIssues = async (urls: string[]) => {
    if (!urls.length) return;
    if (!options.issueFacts) return loadIssues(urls);
    const produced = new Set<string>();
    const facts = await options.issueFacts(
      {
        repository,
        numbers: urls.map((url) => stubs.get(url)!.number),
        issuesPerRequest: bounds.issuesPerRequest,
        concurrency: bounds.hydrationConcurrency,
      },
      async (query, activeSignal, numbers) => {
        const targets = numbers
          ? urls.filter((url) => numbers.includes(stubs.get(url)!.number))
          : urls;
        for (const url of targets) produced.add(`${repository}#${stubs.get(url)!.number}`);
        const coverageStart = meter.coverage.length;
        const warningStart = warnings.length;
        const notAttemptedStart = meter.notAttempted.length;
        await loadIssues(targets, query, activeSignal);
        const coverage = meter.coverage.slice(coverageStart);
        const values = targets.flatMap((url) =>
          hydratedIssues.has(url) ? [hydratedIssues.get(url)!] : [],
        );
        return structuredClone({
          issues: values,
          gone: targets.filter((url) => gone.has(url)),
          unavailable: targets.flatMap((url) =>
            unhydratable.has(url)
              ? [[url, unhydratable.get(url)!] as [string, NotHydratedReason]]
              : [],
          ),
          coverage,
          quota: meter.collection().quota,
          notAttempted: meter.notAttempted.slice(notAttemptedStart),
          warnings: warnings.slice(warningStart),
          complete:
            targets.every((url) => hydratedIssues.has(url) || gone.has(url)) &&
            coverage.every((source) => source.state === "complete") &&
            values.every(
              (value) => !value.labels.pageInfo.hasNextPage && value.blockedBy && value.blocking,
            ),
        });
      },
      signal,
    );
    // Replay cached/joined facts only; own produced sources already contributed telemetry
    // and coverage. Each issue is independently coalesced, even for overlapping selections.
    if (facts.quota) meter.noteQuotaRefusal(facts.quota);
    const copy = structuredClone(facts);
    for (const value of copy.issues) {
      if (!hydratedIssues.has(value.url)) hydratedOrder.push(value.url);
      hydratedIssues.set(value.url, value);
    }
    for (const url of copy.gone) gone.add(url);
    for (const [url, reason] of copy.unavailable) unhydratable.set(url, reason);
    meter.coverage.push(...copy.coverage.filter((source) => !produced.has(source.subject)));
    for (const target of copy.notAttempted)
      if (!meter.notAttempted.includes(target)) meter.notAttempted.push(target);
    for (const warning of copy.warnings) if (!warnings.includes(warning)) warnings.push(warning);
  };
  const restBoundary = options.rest ?? (injected ? undefined : ghRestWith(signal));
  const metredRest = restBoundary
    ? meter.rest(restBoundary, "required-checks", repository)
    : undefined;
  const hydratePrs = async (urls: string[]) => {
    const targets = urls.map((url) => ({ number: stubs.get(url)!.number, url }));
    const read = await hydratePullRequests(
      repository,
      targets,
      { meter, signal, warnings, role: "shortlisted" },
      base,
    );
    const byUrl = new Map(read.map((pr) => [pr.url, pr]));
    for (const { url, number } of targets) {
      const pr = byUrl.get(url);
      if (pr) {
        hydratedPrs.set(url, pr);
        hydratedOrder.push(url);
        continue;
      }
      const last = meter.coverage.findLast(
        (c) => c.source === "pull-request" && c.subject === `${repository}#${number}`,
      );
      if (last?.state === "complete") gone.add(url);
      else unhydratable.set(url, last?.state === "failed" ? "failed" : "not-attempted");
    }
    if (metredRest && read.length)
      warnings.push(
        ...(await hydrateRequiredChecks(repository, read, {
          query: meter.query(base, "required-checks", repository),
          rest: (path) => metredRest(path, { signal }),
        })),
      );
  };

  // 2. Rank, hydrate the frontier, re-rank: until the shown subjects are all hydrated.
  let rounds = 0;
  let capped = false;
  let spent = 0;
  const unread = (subjects: string[]) =>
    subjects.filter((url) => stubs.has(url) && !isHydrated(url) && !gone.has(url));
  /** The last ranking already showed only hydrated subjects: no verification pass needed. */
  let converged = false;
  for (; rounds < bounds.rounds;) {
    rounds++;
    const subjects = await options.select(build());
    // PR obligations (contract: "owned work, PR obligations, ..."): a PR's findings come from
    // checks and reviews that discovery never reads, so every open PR is a frontier candidate
    // after the shown subjects, within the hydration bound; never only those already visible.
    const prObligations = order.filter((url) => kinds.get(url) === "pull-request");
    const pending = needed([...subjects, ...prObligations]).filter(
      (url) => !isHydrated(url) && !gone.has(url) && !unhydratable.has(url),
    );
    if (!pending.length) {
      converged = !unread(subjects).length;
      break;
    }
    // The bound counts reads spent, including those of items later withdrawn.
    const room = bounds.maxHydrated - spent;
    if (room <= 0 || meter.refused) {
      capped = true;
      for (const url of pending)
        unhydratable.set(url, meter.refused ? "not-attempted" : "hydration-cap");
      continue;
    }
    // Whole units only: a unit that does not fit is left unread together, never split.
    const open = (url: string) => !isHydrated(url) && !gone.has(url) && !unhydratable.has(url);
    const take: string[] = [];
    const left: string[] = [];
    for (const unit of units([...subjects, ...prObligations])) {
      // A unit with a member that can no longer be read can never be whole: read none of it.
      if (unit.some((url) => unhydratable.has(url))) continue;
      const members = unit.filter(open).filter((url) => !take.includes(url));
      if (!members.length) continue;
      if (take.length + members.length <= room) take.push(...members);
      else left.push(...members);
    }
    for (const url of left) if (!take.includes(url)) unhydratable.set(url, "hydration-cap");
    if (left.some((url) => !take.includes(url))) capped = true;
    spent += take.length;
    await hydrateIssues(take.filter((url) => kinds.get(url) === "issue"));
    await hydratePrs(take.filter((url) => kinds.get(url) === "pull-request"));
    // Hydration may reveal links discovery did not show; a unit that cannot now be whole is
    // withdrawn rather than shown without its linked evidence.
    if (withdrawIncomplete(false)) capped = true;
  }
  // 3. Never show a stub: withdraw any shown subject that is still unhydrated, then re-rank.
  if (withdrawIncomplete(true)) {
    capped = true;
    converged = false;
  }
  for (let guard = 0; !converged; guard++) {
    if (withdrawIncomplete(true)) capped = true;
    const stale = unread(await options.select(build()));
    if (!stale.length) break;
    for (const url of stale) if (!unhydratable.has(url)) unhydratable.set(url, "hydration-cap");
    capped = true;
    // Bounded: every pass withdraws at least one stub; after `order.length` passes, none remain.
    if (guard > order.length) break;
  }

  const snapshot = build();
  const notHydrated: ShortlistRecord["notHydrated"] = order
    .filter((url) => !isHydrated(url) && !gone.has(url))
    .map((url) => ({
      number: stubs.get(url)!.number,
      url,
      kind: kinds.get(url)!,
      reason: unhydratable.get(url) ?? "not-shortlisted",
    }));
  for (const item of notHydrated)
    if (item.reason === "not-shortlisted" || item.reason === "hydration-cap")
      meter.cover(
        item.kind === "issue" ? "issue" : "pull-request",
        `${repository}#${item.number}`,
        "not-requested",
        {
          omission:
            item.reason === "hydration-cap"
              ? `beyond the hydration bound of ${bounds.maxHydrated}`
              : "not on the briefing shortlist",
        },
      );
  const discoveredComplete = issueInventory.complete && prInventory.complete;
  let notice: string | null = null;
  if (notHydrated.length) {
    const sample = notHydrated
      .slice(0, 5)
      .map((item) => `#${item.number}`)
      .join(", ");
    notice = `Shortlist: ${notHydrated.length} of ${order.length - gone.size} open item(s) were discovered but not hydrated (${sample}${notHydrated.length > 5 ? ", ..." : ""}); their comments, reviews, checks and records are unknown, not empty, so this ordering is provisional${capped ? " (hydration bound reached)" : ""}. Inspect one with pdb --issue N, or read everything with --full.`;
  }
  // Interim default (#368 owner question): unread shortlist items alone leave the briefing
  // complete for what it shows, but provisional. A failed or quota-stopped read of an item the
  // briefing wanted is real incompleteness.
  const failed = notHydrated.filter(
    (i) => i.reason === "failed" || i.reason === "not-attempted" || i.reason === "unavailable",
  );
  if (failed.length)
    snapshot.warnings.push(
      `Shortlist reads failed, were stopped or found the item unavailable for ${failed.length} item(s) (${failed
        .slice(0, 5)
        .map((i) => `#${i.number}`)
        .join(
          ", ",
        )}${failed.length > 5 ? ", ..." : ""}): their evidence is unknown. Inspect one with pdb --issue N.`,
    );
  const collection = meter.collection();
  collection.bounds = { ...bounds };
  const telemetry = collection.telemetry;
  return {
    ...snapshot,
    fetchedAt: now().toISOString(),
    rateLimit:
      telemetry.rateLimit?.remaining != null && telemetry.rateLimit.resetAt
        ? { remaining: telemetry.rateLimit.remaining, resetAt: telemetry.rateLimit.resetAt }
        : null,
    metrics: {
      requestCount: telemetry.requests,
      durationMs: Date.parse(now().toISOString()) - Date.parse(startedAt),
    },
    collection,
    shortlist: {
      schemaVersion: 1,
      profile: "briefing-shortlist-v1",
      discovered: {
        issues: issueInventory.nodes.length,
        pullRequests: prInventory.nodes.length,
        complete: discoveredComplete,
      },
      hydrated: [...hydratedOrder],
      notHydrated,
      rounds,
      provisional: notHydrated.length > 0 || !discoveredComplete,
      notice,
    },
  };
}
