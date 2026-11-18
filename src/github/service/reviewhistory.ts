/**
 * The pull request review-history read for the typed GH service (#950): one bounded document of
 * commits, reviews, review threads and comments, validated before the workflow builds its report.
 */
import type { Query } from "../github.js";

export type Login = { login: string } | null;
export type HistoryComment = {
  author: Login;
  body?: string | null;
  createdAt: string | null;
  url: string;
  originalCommit?: { oid: string } | null;
};
/** The pull request as selected by the review-history document below. */
export type ReviewHistoryNode = {
  number: number;
  url: string;
  headRefOid: string;
  author: Login;
  commits: {
    totalCount?: number;
    nodes: { commit: { oid: string; committedDate?: string; messageHeadline?: string } }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  reviews: {
    nodes: {
      author: Login;
      state: string;
      submittedAt: string | null;
      url: string;
      commit: { oid: string } | null;
    }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated?: boolean;
      path?: string | null;
      line?: number | null;
      comments: { totalCount?: number; nodes: HistoryComment[] };
    }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: { nodes: HistoryComment[]; pageInfo?: { hasNextPage?: boolean } };
};

const reviewHistoryDocument = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url headRefOid author{login}
commits(first:100){totalCount nodes{commit{oid committedDate messageHeadline}} pageInfo{hasNextPage}}
reviews(first:100){nodes{author{login} state submittedAt url commit{oid}} pageInfo{hasNextPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){totalCount nodes{author{login} body createdAt url originalCommit{oid}}}} pageInfo{hasNextPage}}
comments(first:100){nodes{author{login} body createdAt url} pageInfo{hasNextPage}}}}}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
/** Present and either null or a string: an omitted field is missing evidence, not null. */
const strOrNull = (o: Record<string, unknown>, k: string): boolean =>
  k in o && (o[k] === null || str(o[k]));
const actor = (v: unknown): boolean => v === null || (isRecord(v) && str(v.login));
const oidOrNull = (v: unknown): boolean => v === null || (isRecord(v) && str(v.oid));
/** A connection with every node valid and explicit paging evidence. */
const connection = (v: unknown, node: (n: unknown) => boolean, paged = true): boolean =>
  isRecord(v) &&
  Array.isArray(v.nodes) &&
  v.nodes.every((n) => isRecord(n) && node(n)) &&
  (!paged || (isRecord(v.pageInfo) && typeof v.pageInfo.hasNextPage === "boolean"));

const commitNode = (n: unknown): boolean =>
  isRecord(n) &&
  isRecord(n.commit) &&
  str(n.commit.oid) &&
  strOrNull(n.commit, "committedDate") &&
  strOrNull(n.commit, "messageHeadline");
const reviewNode = (n: unknown): boolean =>
  isRecord(n) &&
  "author" in n &&
  actor(n.author) &&
  str(n.state) &&
  strOrNull(n, "submittedAt") &&
  str(n.url) &&
  "commit" in n &&
  oidOrNull(n.commit);
const commentNode =
  (thread: boolean) =>
  (n: unknown): boolean =>
    isRecord(n) &&
    "author" in n &&
    actor(n.author) &&
    strOrNull(n, "body") &&
    strOrNull(n, "createdAt") &&
    str(n.url) &&
    (!thread || ("originalCommit" in n && oidOrNull(n.originalCommit)));
const threadNode = (n: unknown): boolean =>
  isRecord(n) &&
  typeof n.isResolved === "boolean" &&
  typeof n.isOutdated === "boolean" &&
  strOrNull(n, "path") &&
  "line" in n &&
  (n.line === null || typeof n.line === "number") &&
  isRecord(n.comments) &&
  typeof n.comments.totalCount === "number" &&
  connection(n.comments, commentNode(true), false);

/** The review-history reads as one capability object. */
export interface ReviewHistoryReads {
  /**
   * The pull request's bounded history, or null when GitHub reports no such pull request. A
   * present but malformed answer throws, so the report is never built from a partial shape.
   */
  pullHistory(repository: string, number: number): Promise<ReviewHistoryNode | null>;
}

/** Review-history reads over one executor (the facade's own, or a caller's counted one). */
export function reviewHistoryReads(query: Query): ReviewHistoryReads {
  return {
    async pullHistory(repository, number) {
      const [owner, name] = repository.split("/");
      const data = await query(reviewHistoryDocument, { owner: owner!, name: name!, number });
      const repo = isRecord(data) ? data.repository : null;
      if (!isRecord(repo)) throw new Error(`Repository unavailable: ${repository}`);
      const pr = repo.pullRequest;
      if (pr === null || pr === undefined) return null;
      // Every consumed field and every connection's paging evidence is checked here: a
      // malformed record or missing coverage rejects the whole history, never disappears.
      if (
        !isRecord(pr) ||
        typeof pr.number !== "number" ||
        !str(pr.url) ||
        !str(pr.headRefOid) ||
        !("author" in pr) ||
        !actor(pr.author) ||
        !isRecord(pr.commits) ||
        typeof pr.commits.totalCount !== "number" ||
        !connection(pr.commits, commitNode) ||
        !connection(pr.reviews, reviewNode) ||
        !connection(pr.reviewThreads, threadNode) ||
        !connection(pr.comments, commentNode(false))
      )
        throw new Error("GitHub returned a malformed pull request history.");
      return pr as unknown as ReviewHistoryNode;
    },
  };
}
