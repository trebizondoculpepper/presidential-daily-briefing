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
const connection = (v: unknown): boolean => isRecord(v) && Array.isArray(v.nodes);

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
      if (
        !isRecord(pr) ||
        typeof pr.number !== "number" ||
        typeof pr.url !== "string" ||
        typeof pr.headRefOid !== "string" ||
        !connection(pr.commits) ||
        !connection(pr.reviews) ||
        !connection(pr.reviewThreads) ||
        !connection(pr.comments) ||
        !(pr.reviewThreads as { nodes: unknown[] }).nodes.every(
          (t) => isRecord(t) && typeof t.isResolved === "boolean" && connection(t.comments),
        )
      )
        throw new Error("GitHub returned a malformed pull request history.");
      return pr as unknown as ReviewHistoryNode;
    },
  };
}
