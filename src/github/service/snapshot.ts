/**
 * Open-work snapshot reads for the typed GH service (#927): the GraphQL documents behind the
 * shortlist briefing's discovery, batched hydration and comment pagination. Each function takes
 * the caller's (metered, cancellable) query executor, so read metering, budgets and coverage stay
 * with the consumer; documents and connection unwrapping live here.
 */

import type { Query } from "../github.js";
import type { Issue, PullRequest } from "../types.js";

const pageInfoFields = "pageInfo{hasNextPage endCursor}";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function ownerName(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split("/");
  return { owner: owner!, name: name! };
}

/** The repository object of an answer; a missing repository is an error, never empty. */
function repositoryOf(data: unknown, repository: string): Record<string, unknown> {
  const repo = isRecord(data) ? data.repository : null;
  if (!isRecord(repo)) throw new Error(`Repository unavailable: ${repository}`);
  return repo;
}

/** One page of a connection as returned, for the caller's existing page walker. */
export interface ConnectionPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * One page of open issues or pull requests, most recently updated first, with the given fields.
 * The page is returned as GitHub sent it; the caller validates nodes (unreadable discovery).
 */
export async function discoveryPage(
  query: Query,
  repository: string,
  field: "issues" | "pullRequests",
  fields: string,
  pageSize: number,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:${pageSize},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC},states:OPEN){nodes{${fields}} ${pageInfoFields}}}}`;
  const data = await query(source, { ...ownerName(repository), ...(cursor ? { cursor } : {}) });
  return repositoryOf(data, repository)[field];
}

/** One issue's discussion facts (#1099): GitHub's total comment count, never downloaded comments. */
export interface DiscussionNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  /** GitHub's `comments.totalCount`; null when the answer did not carry it. */
  comments: number | null;
}

/** One discussion page as validated: nodes (null when unreadable) and established pagination. */
export interface DiscussionPage {
  nodes: (DiscussionNode | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * One page of issues in the requested state scope with their total comment counts (#1099),
 * most recently updated first. Malformed nodes are returned as null so the caller can count them
 * as unread rather than dropping them; a missing repository is an error, never empty.
 */
export async function discussionPage(
  query: Query,
  repository: string,
  scope: "open" | "closed" | "all",
  pageSize: number,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<DiscussionPage> {
  signal?.throwIfAborted();
  const states = scope === "open" ? "[OPEN]" : scope === "closed" ? "[CLOSED]" : "[OPEN, CLOSED]";
  const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:${pageSize},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC},states:${states}){nodes{number title url state comments{totalCount}} ${pageInfoFields}}}}`;
  const data = await query(source, { ...ownerName(repository), ...(cursor ? { cursor } : {}) });
  const issues = repositoryOf(data, repository).issues;
  if (!isRecord(issues) || !Array.isArray(issues.nodes) || !isRecord(issues.pageInfo))
    throw new Error(`Malformed issue page for ${repository}`);
  const info = issues.pageInfo;
  // Completeness must be established, never assumed: a page that cannot say whether more exist,
  // or claims more without a cursor to reach them, is malformed rather than the end.
  if (
    typeof info.hasNextPage !== "boolean" ||
    (info.hasNextPage && (typeof info.endCursor !== "string" || info.endCursor === ""))
  )
    throw new Error(
      `Malformed issue page for ${repository}: pagination cannot establish completeness`,
    );
  const nodes = issues.nodes.map((node): DiscussionNode | null => {
    if (!isRecord(node)) return null;
    const { number, title, url, state, comments } = node;
    if (
      typeof number !== "number" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      (state !== "OPEN" && state !== "CLOSED")
    )
      return null;
    const total = isRecord(comments) ? comments.totalCount : undefined;
    return {
      number,
      title,
      url,
      state,
      comments: typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null,
    };
  });
  return {
    nodes,
    pageInfo: {
      hasNextPage: info.hasNextPage,
      endCursor: typeof info.endCursor === "string" ? info.endCursor : null,
    },
  };
}

/**
 * Several issues by number in one aliased request, in order. Each entry is the issue as returned
 * or null when absent; the caller validates every node (null or malformed is unknown, not closed).
 */
export async function issuesByNumber(
  query: Query,
  repository: string,
  numbers: readonly number[],
  fields: string,
  signal?: AbortSignal,
): Promise<(Issue | null)[]> {
  signal?.throwIfAborted();
  const declared = numbers.map((_, i) => `$n${i}:Int!`).join(",");
  const selections = numbers.map((_, i) => `i${i}:issue(number:$n${i}){${fields}}`).join(" ");
  const data = await query(
    `query($owner:String!,$name:String!,${declared}){repository(owner:$owner,name:$name){${selections}}}`,
    { ...ownerName(repository), ...Object.fromEntries(numbers.map((n, i) => [`n${i}`, n])) },
  );
  const repo = repositoryOf(data, repository);
  return numbers.map((_, i) => {
    const node = repo[`i${i}`];
    return isRecord(node) ? (node as unknown as Issue) : null;
  });
}

/** One page of an issue's comments with the given comment fields, as returned. */
export async function issueCommentsPage(
  query: Query,
  repository: string,
  number: number,
  commentFields: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){comments(first:100,after:$cursor){nodes{${commentFields}} ${pageInfoFields}}}}}`,
    { ...ownerName(repository), number, cursor },
  );
  const issue = repositoryOf(data, repository).issue;
  return isRecord(issue) ? issue.comments : undefined;
}

export type { Issue, PullRequest };
