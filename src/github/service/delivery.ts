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
