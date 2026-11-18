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
  const actor = (v: unknown): v is { login: string } | null =>
    v === null || v === undefined || (isRecord(v) && str(v.login));
  if (
    !comments.nodes.every(
      (c) =>
        isRecord(c) &&
        str(c.url) &&
        str(c.body) &&
        str(c.createdAt) &&
        (c.databaseId === null || c.databaseId === undefined || int(c.databaseId)) &&
        // Edit evidence must be present: missing evidence is never read as "unedited".
        (c.lastEditedAt === null || str(c.lastEditedAt)) &&
        typeof c.includesCreatedEdit === "boolean" &&
        actor(c.author) &&
        actor(c.editor),
    )
  )
    throw new Error("malformed issue answer");
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
      nodes: (comments.nodes as Record<string, unknown>[]).map((c) => ({
        databaseId: int(c.databaseId) ? c.databaseId : null,
        url: c.url as string,
        body: c.body as string,
        createdAt: c.createdAt as string,
        author: (c.author ?? null) as DeliveryIssueComment["author"],
        lastEditedAt: str(c.lastEditedAt) ? c.lastEditedAt : null,
        includesCreatedEdit: c.includesCreatedEdit as boolean,
        editor: (c.editor ?? null) as DeliveryIssueComment["editor"],
      })),
      pageInfo: {
        hasPreviousPage: info.hasPreviousPage,
        startCursor: str(info.startCursor) ? info.startCursor : null,
      },
    },
  };
}
