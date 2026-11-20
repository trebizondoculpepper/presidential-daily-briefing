/**
 * Ticket-history reads for the typed GH service (#931): validated page-level reads of issues and
 * merged pull requests for bounded history consumers such as the pipeline metrics read. The
 * GraphQL documents and response parsing live here, so consumers never compose queries or read
 * raw JSON. Walking, window cut-offs and read budgets stay with the consumer.
 */

import type { Comment, GraphQuery } from "../../workflow/claims.js";

/** One issue with the fields a ticket ledger needs; comments are the first page only. */
export interface HistoryIssue {
  number: number;
  createdAt: string;
  updatedAt: string;
  state: string;
  closedAt: string | null;
  stateReason: string | null;
  lastEditedAt: string | null;
  labels: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } };
  comments: { totalCount: number; nodes: Comment[] };
  /** Native open blocker count when read; null when absent/unread. */
  openBlockers?: number | null;
  /** Open closing PR count when read completely; null when absent/truncated. */
  openClosingPrs?: number | null;
  /** Assignee logins when read completely (#688); null when absent or truncated (unknown). */
  assignees?: string[] | null;
}

/** One merged pull request and the same-repository issues it closes. */
export interface MergedPull {
  number: number;
  updatedAt: string;
  mergedAt: string | null;
  /** Closing references, owner/name lowercased as given. */
  closes: { number: number; repository: string }[];
  /** More closing references than were read. */
  closesTruncated: boolean;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface HistoryReads {
  /** All-state issues, most recently updated first. */
  issuesByUpdate(repository: string, cursor: string | null): Promise<Page<HistoryIssue>>;
  /** Open issues, oldest first. */
  openIssues(repository: string, cursor: string | null): Promise<Page<HistoryIssue>>;
  /** Merged pull requests, most recently updated first. */
  mergedPulls(repository: string, cursor: string | null): Promise<Page<MergedPull>>;
  /** One issue, or null when it does not exist or cannot be seen. */
  issue(repository: string, number: number): Promise<HistoryIssue | null>;
  /** A pull request's state and merge time, or null when it cannot be seen. */
  pullState(
    repository: string,
    number: number,
  ): Promise<{ number: number; state: string; mergedAt: string | null } | null>;
}

const commentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";
const issueFields =
  "number createdAt updatedAt lastEditedAt state closedAt stateReason issueDependenciesSummary{blockedBy} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number state} pageInfo{hasNextPage}} labels(first:100){nodes{name} pageInfo{hasNextPage}} assignees(first:20){nodes{login} pageInfo{hasNextPage}} comments(first:100){totalCount nodes{" +
  commentFields +
  "}}";
const issuePage = (states: string, order: string) =>
  `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:50,after:$cursor,states:[${states}],orderBy:{field:${order}}){nodes{${issueFields}} pageInfo{hasNextPage endCursor}}}}`;
const byUpdateQuery = issuePage("OPEN,CLOSED", "UPDATED_AT,direction:DESC");
const openQuery = issuePage("OPEN", "CREATED_AT,direction:ASC");
const mergedQuery = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:50,after:$cursor,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt mergedAt closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}`;
const issueQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${issueFields}}}}`;
const pullQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state mergedAt}}}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

class MalformedHistory extends Error {
  constructor(what: string) {
    super(`GitHub returned a malformed ${what}; no metrics were derived from it.`);
  }
}

function issueOf(v: unknown): HistoryIssue {
  if (!isRecord(v) || !int(v.number) || !str(v.createdAt) || !str(v.updatedAt) || !str(v.state))
    throw new MalformedHistory("issue");
  const comments = isRecord(v.comments) ? v.comments : null;
  if (!comments || !int(comments.totalCount) || !Array.isArray(comments.nodes))
    throw new MalformedHistory("issue comment page");
  const labels = isRecord(v.labels) ? v.labels : null;
  const labelNodes = labels && Array.isArray(labels.nodes) ? labels.nodes : null;
  return {
    number: v.number,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    state: v.state,
    closedAt: strOrNull(v.closedAt),
    stateReason: strOrNull(v.stateReason),
    lastEditedAt: strOrNull(v.lastEditedAt),
    labels: {
      nodes: (labelNodes ?? []).filter((n): n is { name: string } => isRecord(n) && str(n.name)),
      // Unknown label completeness is reported as more labels remaining, never as complete.
      pageInfo: {
        hasNextPage:
          !labels || !labelNodes || !isRecord(labels.pageInfo)
            ? true
            : labels.pageInfo.hasNextPage !== false,
      },
    },
    comments: {
      totalCount: comments.totalCount,
      nodes: comments.nodes.filter((c): c is Comment => isRecord(c) && str(c.body)),
    },
    openBlockers:
      isRecord(v.issueDependenciesSummary) && int(v.issueDependenciesSummary.blockedBy)
        ? v.issueDependenciesSummary.blockedBy
        : null,
    openClosingPrs:
      isRecord(v.closedByPullRequestsReferences) &&
      isRecord(v.closedByPullRequestsReferences.pageInfo) &&
      v.closedByPullRequestsReferences.pageInfo.hasNextPage === false &&
      Array.isArray(v.closedByPullRequestsReferences.nodes)
        ? v.closedByPullRequestsReferences.nodes.filter(
            (n) => isRecord(n) && (n.state === undefined || n.state === "OPEN"),
          ).length
        : null,
    assignees:
      isRecord(v.assignees) &&
      isRecord(v.assignees.pageInfo) &&
      v.assignees.pageInfo.hasNextPage === false &&
      Array.isArray(v.assignees.nodes) &&
      v.assignees.nodes.every((n) => isRecord(n) && str(n.login))
        ? v.assignees.nodes.map((n) => (n as { login: string }).login)
        : null,
  };
}

function pullOf(v: unknown): MergedPull {
  if (!isRecord(v) || !int(v.number) || !str(v.updatedAt))
    throw new MalformedHistory("pull request");
  const refs = isRecord(v.closingIssuesReferences) ? v.closingIssuesReferences : null;
  const nodes = refs && Array.isArray(refs.nodes) ? refs.nodes : [];
  const closes = nodes.flatMap((n) =>
    isRecord(n) && int(n.number) && isRecord(n.repository) && str(n.repository.nameWithOwner)
      ? [{ number: n.number, repository: n.repository.nameWithOwner }]
      : [],
  );
  return {
    number: v.number,
    updatedAt: v.updatedAt,
    mergedAt: strOrNull(v.mergedAt),
    closes,
    // Missing paging evidence is truncation, never completeness.
    closesTruncated: !refs || !isRecord(refs.pageInfo) || refs.pageInfo.hasNextPage !== false,
  };
}

function connection(data: unknown, repository: string, field: string): Record<string, unknown> {
  const repo = isRecord(data) ? data.repository : null;
  if (!isRecord(repo)) throw new Error(`Repository unavailable: ${repository}`);
  const conn = repo[field];
  if (!isRecord(conn) || !Array.isArray(conn.nodes)) throw new MalformedHistory(`${field} page`);
  return conn;
}

function pageInfo(conn: Record<string, unknown>): {
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const info = isRecord(conn.pageInfo) ? conn.pageInfo : null;
  return {
    hasNextPage: info?.hasNextPage === true,
    endCursor: info ? strOrNull(info.endCursor) : null,
  };
}

/** History reads over a GraphQL executor (the service's own, or a caller's counted one). */
export function historyReads(query: GraphQuery): HistoryReads {
  const owner = (repository: string) => {
    const [o, n] = repository.split("/");
    return { owner: o!, name: n! };
  };
  const vars = (repository: string, cursor: string | null) => ({
    ...owner(repository),
    ...(cursor ? { cursor } : {}),
  });
  const issues = async (doc: string, repository: string, cursor: string | null) => {
    const conn = connection(await query(doc, vars(repository, cursor)), repository, "issues");
    return { nodes: (conn.nodes as unknown[]).map(issueOf), ...pageInfo(conn) };
  };
  return {
    issuesByUpdate: (repository, cursor) => issues(byUpdateQuery, repository, cursor),
    openIssues: (repository, cursor) => issues(openQuery, repository, cursor),
    async mergedPulls(repository, cursor) {
      const conn = connection(
        await query(mergedQuery, vars(repository, cursor)),
        repository,
        "pullRequests",
      );
      return {
        nodes: (conn.nodes as unknown[]).map(pullOf),
        ...pageInfo(conn),
      };
    },
    async issue(repository, number) {
      const data = await query(issueQuery, { ...owner(repository), number });
      const node = isRecord(data) && isRecord(data.repository) ? data.repository.issue : null;
      return node ? issueOf(node) : null;
    },
    async pullState(repository, number) {
      const data = await query(pullQuery, { ...owner(repository), number });
      const node = isRecord(data) && isRecord(data.repository) ? data.repository.pullRequest : null;
      if (!isRecord(node) || !int(node.number) || !str(node.state)) return null;
      return { number: node.number, state: node.state, mergedAt: strOrNull(node.mergedAt) };
    },
  };
}
