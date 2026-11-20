/**
 * Delivery-issue reads for the typed GH service (#945): one issue's state, closing pull requests
 * and newest comment page, for delivery views. The GraphQL document and its validation live here;
 * paging older comment history and the delivery diagnosis stay with their workflow modules.
 */

import type { Query } from "../github.js";

/** The fields a delivery comment carries; kept identical to deliverables' read (#189). */
const deliveryIssueCommentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";

/** One validated delivery comment record. */
export interface DeliveryIssueComment {
  databaseId: number | null;
  url: string;
  body: string;
  createdAt: string;
  author: { __typename?: string; login: string } | null;
  lastEditedAt: string | null;
  includesCreatedEdit: boolean;
  editor: { __typename?: string; login: string } | null;
}

export interface DeliveryIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  closedByPullRequestsReferences: {
    nodes: { number: number; url: string; state: string }[];
    pageInfo: { hasNextPage: boolean };
  } | null;
  /** The newest comment page, as the history pager expects it. */
  comments: {
    nodes: DeliveryIssueComment[];
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** Present as null (a deleted account) or an actor; an omitted field is missing evidence. */
const actor = (v: unknown): v is { login: string } | null =>
  v === null || (isRecord(v) && str(v.login));

/** One delivery comment record, with its edit evidence present (never read as "unedited"). */
function validComment(c: unknown): boolean {
  return (
    isRecord(c) &&
    str(c.url) &&
    str(c.body) &&
    str(c.createdAt) &&
    (c.databaseId === null || c.databaseId === undefined || int(c.databaseId)) &&
    (c.lastEditedAt === null || str(c.lastEditedAt)) &&
    typeof c.includesCreatedEdit === "boolean" &&
    actor(c.author) &&
    actor(c.editor)
  );
}

const toComment = (c: Record<string, unknown>): DeliveryIssueComment => ({
  databaseId: int(c.databaseId) ? c.databaseId : null,
  url: c.url as string,
  body: c.body as string,
  createdAt: c.createdAt as string,
  author: c.author as DeliveryIssueComment["author"],
  lastEditedAt: str(c.lastEditedAt) ? c.lastEditedAt : null,
  includesCreatedEdit: c.includesCreatedEdit as boolean,
  editor: c.editor as DeliveryIssueComment["editor"],
});

/**
 * Read one issue for its delivery view. Null when GitHub reports no such issue; a present but
 * malformed answer is rejected, so its delivery is reported unknown rather than guessed.
 */
export async function deliveryIssue(
  query: Query,
  repository: string,
  number: number,
): Promise<DeliveryIssue | null> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title url state stateReason closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${deliveryIssueCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
    { owner: owner!, name: name!, number },
  );
  const repo = isRecord(data) ? data.repository : null;
  if (!isRecord(repo)) throw new Error("not readable");
  const node = repo.issue;
  if (node === null || node === undefined) return null;
  const comments = isRecord(node) && isRecord(node.comments) ? node.comments : null;
  const info = comments && isRecord(comments.pageInfo) ? comments.pageInfo : null;
  if (
    !isRecord(node) ||
    !int(node.number) ||
    !str(node.title) ||
    !str(node.url) ||
    !str(node.state) ||
    !comments ||
    !Array.isArray(comments.nodes) ||
    !info ||
    typeof info.hasPreviousPage !== "boolean"
  )
    throw new Error("malformed issue answer");
  // Every comment record is validated here; one malformed record makes the issue unreadable
  // (its delivery unknown), never silently dropped.
  if (!comments.nodes.every(validComment)) throw new Error("malformed issue answer");
  const closing = isRecord(node.closedByPullRequestsReferences)
    ? node.closedByPullRequestsReferences
    : null;
  // An unreadable closing reference is never filtered into a complete-looking list.
  if (
    closing &&
    (!Array.isArray(closing.nodes) ||
      !closing.nodes.every((n) => isRecord(n) && int(n.number) && str(n.url) && str(n.state)))
  )
    throw new Error("malformed issue answer");
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    stateReason: str(node.stateReason) ? node.stateReason : null,
    closedByPullRequestsReferences: closing
      ? {
          nodes: closing.nodes as { number: number; url: string; state: string }[],
          // Missing paging evidence is reported as more remaining, never as complete.
          pageInfo: {
            hasNextPage: !isRecord(closing.pageInfo) || closing.pageInfo.hasNextPage !== false,
          },
        }
      : null,
    comments: {
      nodes: (comments.nodes as Record<string, unknown>[]).map(toComment),
      pageInfo: {
        hasPreviousPage: info.hasPreviousPage,
        startCursor: str(info.startCursor) ? info.startCursor : null,
      },
    },
  };
}

/** A recently closed issue for the closed-drift scan, with its closer and newest comments. */
export interface ClosedDeliveryIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  closedAt: string | null;
  /** The latest close event's actor, as selected (null actor: a deleted account). */
  timelineItems: { nodes: ({ actor?: { login: string } | null } | null)[] };
  comments: {
    nodes: DeliveryIssueComment[];
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  };
}

/**
 * Closed issues updated since `since`, one bounded page, most recent first (#944). Throws on an
 * unreadable repository or any malformed issue, closer or comment record, so the scan is
 * reported incomplete rather than "no drift".
 */
export async function closedIssuesSince(
  query: Query,
  repository: string,
  since: string,
  first: number,
): Promise<{ nodes: ClosedDeliveryIssue[]; hasNextPage: boolean }> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$since:DateTime!,$first:Int!){repository(owner:$owner,name:$name){issues(states:CLOSED,first:$first,orderBy:{field:UPDATED_AT,direction:DESC},filterBy:{since:$since}){nodes{number title url state stateReason closedAt timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{actor{login}}}} comments(last:100){nodes{${deliveryIssueCommentFields}} pageInfo{hasPreviousPage startCursor}}} pageInfo{hasNextPage}}}}`,
    { owner: owner!, name: name!, since, first },
  );
  const repo = isRecord(data) ? data.repository : null;
  if (!isRecord(repo)) throw new Error(`repository ${repository} unavailable`);
  const issues = repo.issues;
  if (
    !isRecord(issues) ||
    !Array.isArray(issues.nodes) ||
    !isRecord(issues.pageInfo) ||
    typeof issues.pageInfo.hasNextPage !== "boolean"
  )
    throw new Error("malformed closed-issue page");
  const nodes = issues.nodes.map((n): ClosedDeliveryIssue => {
    const comments = isRecord(n) && isRecord(n.comments) ? n.comments : null;
    const info = comments && isRecord(comments.pageInfo) ? comments.pageInfo : null;
    const timeline = isRecord(n) && isRecord(n.timelineItems) ? n.timelineItems : null;
    if (
      !isRecord(n) ||
      !int(n.number) ||
      !str(n.title) ||
      !str(n.url) ||
      !str(n.state) ||
      !(n.stateReason === null || str(n.stateReason)) ||
      !(n.closedAt === null || str(n.closedAt)) ||
      !timeline ||
      !Array.isArray(timeline.nodes) ||
      !timeline.nodes.every(
        (e) => e === null || (isRecord(e) && (e.actor === undefined || actor(e.actor))),
      ) ||
      !comments ||
      !Array.isArray(comments.nodes) ||
      !comments.nodes.every(validComment) ||
      !info ||
      typeof info.hasPreviousPage !== "boolean"
    )
      throw new Error("malformed closed issue");
    return {
      number: n.number,
      title: n.title,
      url: n.url,
      state: n.state,
      stateReason: n.stateReason as string | null,
      closedAt: n.closedAt as string | null,
      timelineItems: { nodes: timeline.nodes as ClosedDeliveryIssue["timelineItems"]["nodes"] },
      comments: {
        nodes: (comments.nodes as Record<string, unknown>[]).map(toComment),
        pageInfo: {
          hasPreviousPage: info.hasPreviousPage,
          startCursor: str(info.startCursor) ? info.startCursor : null,
        },
      },
    };
  });
  return { nodes, hasNextPage: issues.pageInfo.hasNextPage };
}

/** The delivery reads as one capability object: the facade's `delivery` group. */
export interface DeliveryReads {
  /** One issue's state, closing PRs and validated newest comments; null only when absent. */
  issue(repository: string, number: number): Promise<DeliveryIssue | null>;
  /** Recently closed issues for the closed-drift scan, one bounded page. */
  closedSince(
    repository: string,
    since: string,
    first: number,
  ): Promise<{ nodes: ClosedDeliveryIssue[]; hasNextPage: boolean }>;
}

/** Delivery reads over one executor (the facade's own, or a caller's counted one). */
export function deliveryReads(query: Query): DeliveryReads {
  return {
    issue: (repository, number) => deliveryIssue(query, repository, number),
    closedSince: (repository, since, first) => closedIssuesSince(query, repository, since, first),
  };
}

/** One validated older page of an issue's delivery comments (newest-first paging backwards). */
export async function olderCommentsPage(
  query: Query,
  repository: string,
  number: number,
  before: string,
): Promise<{
  nodes: DeliveryIssueComment[];
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
} | null> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$before:String!){repository(owner:$owner,name:$name){issue(number:$number){comments(last:100,before:$before){nodes{${deliveryIssueCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
    { owner: owner!, name: name!, number, before },
  );
  const repo = isRecord(data) ? data.repository : null;
  const issue = isRecord(repo) ? repo.issue : null;
  const comments = isRecord(issue) ? issue.comments : null;
  // An unreadable page is null (the caller reports history incomplete); a malformed one throws.
  if (!isRecord(comments)) return null;
  const info = isRecord(comments.pageInfo) ? comments.pageInfo : null;
  if (
    !Array.isArray(comments.nodes) ||
    !comments.nodes.every(validComment) ||
    !info ||
    typeof info.hasPreviousPage !== "boolean"
  )
    throw new Error("malformed comment page");
  return {
    nodes: (comments.nodes as Record<string, unknown>[]).map(toComment),
    pageInfo: {
      hasPreviousPage: info.hasPreviousPage,
      startCursor: str(info.startCursor) ? info.startCursor : null,
    },
  };
}

/** A pull request by URL with the identity and target facts deliverables record. */
export interface LivePr {
  id: string;
  number: number;
  url: string;
  state: string;
  isDraft?: boolean;
  merged: boolean;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  baseRefName: string;
  baseRepository: { nameWithOwner: string; defaultBranchRef: { name: string } | null } | null;
  closingIssuesReferences?: {
    nodes: { number: number; repository: { nameWithOwner: string } }[];
  };
}

/** A pull request by URL, or null when it is not a readable, well-formed pull request. */
export async function pullByUrl(query: Query, url: string): Promise<LivePr | null> {
  try {
    const data = await query(
      `query($url:URI!){resource(url:$url){__typename ... on PullRequest{id number url state isDraft merged mergeCommit{oid} headRefOid baseRefName baseRepository{nameWithOwner defaultBranchRef{name}} closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}}}}}}`,
      { url },
    );
    const r = isRecord(data) ? data.resource : null;
    if (!isRecord(r) || r.__typename !== "PullRequest") return null;
    const base = r.baseRepository;
    const closing = r.closingIssuesReferences;
    const valid =
      str(r.id) &&
      r.id !== "" &&
      int(r.number) &&
      str(r.url) &&
      str(r.state) &&
      r.state !== "" &&
      (r.isDraft === undefined || typeof r.isDraft === "boolean") &&
      typeof r.merged === "boolean" &&
      (r.mergeCommit === null || (isRecord(r.mergeCommit) && str(r.mergeCommit.oid))) &&
      str(r.headRefOid) &&
      str(r.baseRefName) &&
      r.baseRefName !== "" &&
      isRecord(base) &&
      str(base.nameWithOwner) &&
      (base.defaultBranchRef === null ||
        (isRecord(base.defaultBranchRef) && str(base.defaultBranchRef.name))) &&
      (closing === undefined ||
        (isRecord(closing) &&
          Array.isArray(closing.nodes) &&
          closing.nodes.every(
            (n) =>
              isRecord(n) &&
              int(n.number) &&
              isRecord(n.repository) &&
              str(n.repository.nameWithOwner),
          )));
    return valid ? (r as unknown as LivePr) : null;
  } catch {
    return null;
  }
}

/**
 * Issues that may record a pull request as a delivery member (#1019): those it closes and those
 * whose comments cross-reference it (delivery records name their members in visible text, so
 * GitHub records the reference). `complete` is false when either list has more pages; null when
 * the pull request is unreadable.
 */
export async function pullReferencingIssues(
  query: Query,
  url: string,
): Promise<{ issues: { repository: string; number: number }[]; complete: boolean } | null> {
  try {
    const data = await query(
      `query($url:URI!){resource(url:$url){__typename ... on PullRequest{closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}} timelineItems(itemTypes:[CROSS_REFERENCED_EVENT],first:100){nodes{... on CrossReferencedEvent{source{__typename ... on Issue{number repository{nameWithOwner}}}}} pageInfo{hasNextPage}}}}}`,
      { url },
    );
    const r = isRecord(data) ? data.resource : null;
    if (!isRecord(r) || r.__typename !== "PullRequest") return null;
    const closing = r.closingIssuesReferences;
    const timeline = r.timelineItems;
    if (!isRecord(closing) || !Array.isArray(closing.nodes) || !isRecord(timeline)) return null;
    if (!Array.isArray(timeline.nodes)) return null;
    const issues: { repository: string; number: number }[] = [];
    const add = (n: unknown): boolean => {
      if (!isRecord(n) || !int(n.number) || !isRecord(n.repository)) return false;
      if (!str(n.repository.nameWithOwner)) return false;
      issues.push({ repository: n.repository.nameWithOwner, number: n.number });
      return true;
    };
    if (!closing.nodes.every(add)) return null;
    // A reference whose source cannot be read (an inaccessible issue) may record an owner: the
    // list is then incomplete, never complete (#1149 review; shortlist.ts treats it alike).
    let unreadable = false;
    for (const t of timeline.nodes) {
      const source = isRecord(t) ? t.source : null;
      if (!isRecord(source)) {
        unreadable = true;
        continue;
      }
      // Pull requests that mention it hold no delivery records; only issues do.
      if (source.__typename === "Issue" && !add(source)) return null;
    }
    const more = (c: Record<string, unknown>): boolean =>
      !isRecord(c.pageInfo) || c.pageInfo.hasNextPage !== false;
    return { issues, complete: !unreadable && !more(closing) && !more(timeline) };
  } catch {
    return null;
  }
}

/** The viewer and the issue (or a pull request in its place) for a deliverables plan (#943). */
export interface DeliverableIssueRead {
  viewer: { __typename?: string; login?: string } | null;
  item:
    | {
        __typename: "Issue";
        number: number;
        title: string;
        url: string;
        state: string;
        labels: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } };
        closedByPullRequestsReferences: {
          nodes: { number: number; url: string; state: string }[];
          pageInfo: { hasNextPage: boolean };
        };
        comments: {
          nodes: DeliveryIssueComment[];
          pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
        };
      }
    | { __typename: "PullRequest"; url: string }
    | null;
}

/**
 * Read the viewer and an issue for a deliverables plan. Throws when the repository is
 * unavailable or any part of the answer is malformed; missing paging evidence is more remaining.
 */
export async function deliverableIssue(
  query: Query,
  repository: string,
  number: number,
): Promise<DeliverableIssueRead> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){viewer{__typename login} repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{url} ... on Issue{number title url state labels(first:100){nodes{name} pageInfo{hasNextPage}} closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${deliveryIssueCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}}`,
    { owner: owner!, name: name!, number },
  );
  const repo = isRecord(data) ? data.repository : null;
  if (!isRecord(repo)) throw new Error(`Repository unavailable: ${repository}`);
  const v = isRecord(data) ? data.viewer : null;
  const viewer =
    v === null || v === undefined
      ? null
      : isRecord(v) && (v.login === undefined || str(v.login))
        ? (v as DeliverableIssueRead["viewer"])
        : (() => {
            throw new Error("malformed issue answer");
          })();
  const node = repo.issueOrPullRequest;
  if (node === null || node === undefined) return { viewer, item: null };
  if (!isRecord(node)) throw new Error("malformed issue answer");
  if (node.__typename === "PullRequest") {
    if (!str(node.url)) throw new Error("malformed issue answer");
    return { viewer, item: { __typename: "PullRequest", url: node.url } };
  }
  const labels = isRecord(node.labels) ? node.labels : null;
  const closing = isRecord(node.closedByPullRequestsReferences)
    ? node.closedByPullRequestsReferences
    : null;
  const comments = isRecord(node.comments) ? node.comments : null;
  const info = comments && isRecord(comments.pageInfo) ? comments.pageInfo : null;
  if (
    node.__typename !== "Issue" ||
    !int(node.number) ||
    !str(node.title) ||
    !str(node.url) ||
    !str(node.state) ||
    !labels ||
    !Array.isArray(labels.nodes) ||
    !labels.nodes.every((l) => isRecord(l) && str(l.name)) ||
    !closing ||
    !Array.isArray(closing.nodes) ||
    !closing.nodes.every((n) => isRecord(n) && int(n.number) && str(n.url) && str(n.state)) ||
    !comments ||
    !Array.isArray(comments.nodes) ||
    !comments.nodes.every(validComment) ||
    !info ||
    typeof info.hasPreviousPage !== "boolean"
  )
    throw new Error("malformed issue answer");
  const more = (p: unknown) => !isRecord(p) || p.hasNextPage !== false;
  return {
    viewer,
    item: {
      __typename: "Issue",
      number: node.number,
      title: node.title,
      url: node.url,
      state: node.state,
      labels: {
        nodes: labels.nodes as { name: string }[],
        pageInfo: { hasNextPage: more(labels.pageInfo) },
      },
      closedByPullRequestsReferences: {
        nodes: closing.nodes as { number: number; url: string; state: string }[],
        pageInfo: { hasNextPage: more(closing.pageInfo) },
      },
      comments: {
        nodes: (comments.nodes as Record<string, unknown>[]).map(toComment),
        pageInfo: {
          hasPreviousPage: info.hasPreviousPage,
          startCursor: str(info.startCursor) ? info.startCursor : null,
        },
      },
    },
  };
}
