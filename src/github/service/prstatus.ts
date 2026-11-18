/**
 * The pull request status read for the typed GH service (#946): one bounded document (state,
 * head checks, reviews, threads, comments, closing issues), every consumed field and every
 * connection's paging evidence validated before the workflow builds its report.
 */
import type { Query } from "../github.js";
import type { RequiredChecks } from "./checks.js";

export type Login = { __typename?: string; login: string } | null;
export type PageInfo = { hasNextPage?: boolean; hasPreviousPage?: boolean };
export type CheckContext = {
  databaseId?: number | null;
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** The GitHub App that published a check run: provider identity, never its display name. */
  checkSuite?: { app: { slug: string; databaseId?: number } | null } | null;
  /** Whether GitHub requires this check for this PR (#343); null/absent is unknown. */
  isRequired?: boolean | null;
};
export type ReviewNode = {
  author: Login;
  state: string;
  submittedAt: string | null;
  url: string;
  commit: { oid: string } | null;
};
export type ThreadComment = { author: Login; body?: string; createdAt: string | null; url: string };
export type ThreadNode = {
  isResolved: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  first?: { totalCount?: number; nodes: ThreadComment[] } | null;
  latest?: { nodes: ThreadComment[] } | null;
};
export type CommentNode = { author: Login; body: string | null; createdAt: string; url: string };
export type LinkedIssueNode = {
  number: number;
  url: string;
  title: string;
  state: string;
  labels: { nodes: { name: string }[] };
};
/** The pull request as selected by the status document below. */
export type PullRequestNode = {
  requiredChecks?: RequiredChecks;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  merged?: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision?: string | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  commits: {
    nodes: {
      commit: {
        oid?: string;
        statusCheckRollup: {
          state?: string;
          contexts: { nodes: CheckContext[]; pageInfo: PageInfo };
        } | null;
      };
    }[];
  };
  reviews: { nodes: ReviewNode[]; pageInfo?: PageInfo };
  reviewThreads: { nodes: ThreadNode[]; pageInfo: PageInfo };
  comments: { nodes: CommentNode[]; pageInfo?: PageInfo };
  closingIssuesReferences: { nodes: LinkedIssueNode[]; pageInfo?: PageInfo };
};

const statusDocument = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title url state isDraft merged mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName updatedAt
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name databaseId status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$number) checkSuite{app{slug databaseId}}} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage}}}}}}
reviews(last:50){nodes{author{__typename login} state submittedAt url commit{oid}} pageInfo{hasPreviousPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line first:comments(first:1){totalCount nodes{author{__typename login} body createdAt url}} latest:comments(last:1){nodes{author{login} createdAt url}}} pageInfo{hasNextPage}}
comments(last:100){nodes{author{__typename login} body createdAt url} pageInfo{hasPreviousPage}}
closingIssuesReferences(first:10){nodes{number url title state labels(first:50){nodes{name}}} pageInfo{hasNextPage}}}}}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v);
/** Absent, null or a string (the node type marks these optional); any other type is malformed. */
const strOrNull = (o: Record<string, unknown>, k: string): boolean =>
  o[k] === undefined || o[k] === null || str(o[k]);
const boolOrNull = (o: Record<string, unknown>, k: string): boolean =>
  o[k] === undefined || o[k] === null || typeof o[k] === "boolean";
const optBool = (o: Record<string, unknown>, k: string): boolean =>
  o[k] === undefined || typeof o[k] === "boolean";
const actor = (v: unknown): boolean =>
  v === null || (isRecord(v) && str(v.login) && (v.__typename === undefined || str(v.__typename)));
/** Required by the node type: present, and null or a string. */
const reqStrOrNull = (o: Record<string, unknown>, k: string): boolean =>
  k in o && (o[k] === null || str(o[k]));
/** Paging evidence: absent is allowed here and normalised to "more remains" before returning. */
const page = (v: unknown, key: "hasNextPage" | "hasPreviousPage"): boolean =>
  isRecord(v) &&
  (v.pageInfo === undefined ||
    (isRecord(v.pageInfo) &&
      (v.pageInfo[key] === undefined || typeof v.pageInfo[key] === "boolean")));
const nodes = (v: unknown, valid: (n: Record<string, unknown>) => boolean): boolean =>
  isRecord(v) && Array.isArray(v.nodes) && v.nodes.every((n) => isRecord(n) && valid(n));

const optStr = (o: Record<string, unknown>, k: string): boolean => o[k] === undefined || str(o[k]);
const optInt = (o: Record<string, unknown>, k: string): boolean =>
  o[k] === undefined || o[k] === null || int(o[k]);
/** A check run or status context: type-checked field by field; the union member is by shape. */
const checkContext = (n: Record<string, unknown>): boolean =>
  (n.__typename === undefined || n.__typename === "CheckRun" || n.__typename === "StatusContext") &&
  (str(n.name) || str(n.context)) &&
  optStr(n, "name") &&
  optStr(n, "context") &&
  optInt(n, "databaseId") &&
  ["status", "conclusion", "state", "detailsUrl", "targetUrl", "startedAt", "completedAt"].every(
    (k) => strOrNull(n, k),
  ) &&
  boolOrNull(n, "isRequired") &&
  (n.checkSuite === undefined ||
    n.checkSuite === null ||
    (isRecord(n.checkSuite) &&
      (n.checkSuite.app === undefined ||
        n.checkSuite.app === null ||
        (isRecord(n.checkSuite.app) &&
          optStr(n.checkSuite.app, "slug") &&
          optInt(n.checkSuite.app, "databaseId")))));
const commitNode = (n: Record<string, unknown>): boolean => {
  const c = n.commit;
  if (!isRecord(c) || (c.oid !== undefined && !str(c.oid)) || !strOrNull(c, "committedDate"))
    return false;
  const rollup = c.statusCheckRollup;
  return (
    rollup === undefined ||
    rollup === null ||
    (isRecord(rollup) &&
      strOrNull(rollup, "state") &&
      nodes(rollup.contexts, checkContext) &&
      page(rollup.contexts, "hasNextPage"))
  );
};
const reviewNode = (n: Record<string, unknown>): boolean =>
  "author" in n &&
  actor(n.author) &&
  str(n.state) &&
  reqStrOrNull(n, "submittedAt") &&
  str(n.url) &&
  "commit" in n &&
  (n.commit === null || (isRecord(n.commit) && str(n.commit.oid)));
const threadComment =
  (withBody: boolean) =>
  (n: Record<string, unknown>): boolean =>
    "author" in n &&
    actor(n.author) &&
    reqStrOrNull(n, "createdAt") &&
    str(n.url) &&
    (!withBody || strOrNull(n, "body"));
const threadNode = (n: Record<string, unknown>): boolean =>
  typeof n.isResolved === "boolean" &&
  optBool(n, "isOutdated") &&
  strOrNull(n, "path") &&
  (n.line === undefined || n.line === null || int(n.line)) &&
  (n.first === undefined ||
    n.first === null ||
    (((n.first as Record<string, unknown>).totalCount === undefined ||
      int((n.first as Record<string, unknown>).totalCount)) &&
      nodes(n.first, threadComment(true)))) &&
  (n.latest === undefined || n.latest === null || nodes(n.latest, threadComment(false)));
const commentNode = (n: Record<string, unknown>): boolean =>
  "author" in n && actor(n.author) && reqStrOrNull(n, "body") && str(n.createdAt) && str(n.url);
const linkedIssue = (n: Record<string, unknown>): boolean =>
  int(n.number) &&
  str(n.url) &&
  str(n.title) &&
  str(n.state) &&
  nodes(n.labels, (l) => str(l.name));

/** Whether a present pull request answer carries every field the status report consumes. */
function validStatus(pr: Record<string, unknown>): boolean {
  return (
    int(pr.number) &&
    [
      "title",
      "url",
      "state",
      "mergeable",
      "mergeStateStatus",
      "headRefOid",
      "headRefName",
      "baseRefName",
      "updatedAt",
    ].every((k) => str(pr[k])) &&
    optBool(pr, "isDraft") &&
    optBool(pr, "merged") &&
    strOrNull(pr, "reviewDecision") &&
    nodes(pr.commits, commitNode) &&
    nodes(pr.reviews, reviewNode) &&
    page(pr.reviews, "hasPreviousPage") &&
    nodes(pr.reviewThreads, threadNode) &&
    page(pr.reviewThreads, "hasNextPage") &&
    nodes(pr.comments, commentNode) &&
    page(pr.comments, "hasPreviousPage") &&
    nodes(pr.closingIssuesReferences, linkedIssue) &&
    page(pr.closingIssuesReferences, "hasNextPage")
  );
}

/** The status reads as one capability object: the facade's `prStatus` group. */
export interface PrStatusReads {
  /**
   * The pull request's status node, or null when GitHub reports no such pull request. A present
   * but malformed answer throws, so the report is never built from a partial shape.
   */
  pullRequest(repository: string, number: number): Promise<PullRequestNode | null>;
}

/** Status reads over one executor (the facade's own, or a read's metered one). */
export function prStatusReads(query: Query): PrStatusReads {
  return {
    async pullRequest(repository, number) {
      const [owner, name] = repository.split("/");
      const data = await query(statusDocument, { owner: owner!, name: name!, number });
      const repo = isRecord(data) ? data.repository : null;
      if (!isRecord(repo)) throw new Error(`Repository unavailable: ${repository}`);
      const pr = repo.pullRequest;
      if (pr === null || pr === undefined) return null;
      if (!isRecord(pr) || !validStatus(pr))
        throw new Error("GitHub returned a malformed pull request status.");
      // Missing paging evidence is never read as complete: it becomes "more remains".
      const paged = (conn: unknown, key: "hasNextPage" | "hasPreviousPage") => {
        const c = conn as Record<string, unknown>;
        const info = isRecord(c.pageInfo) ? c.pageInfo : {};
        if (typeof info[key] !== "boolean") c.pageInfo = { ...info, [key]: true };
      };
      paged(pr.reviews, "hasPreviousPage");
      paged(pr.reviewThreads, "hasNextPage");
      paged(pr.comments, "hasPreviousPage");
      paged(pr.closingIssuesReferences, "hasNextPage");
      for (const node of (pr.commits as { nodes: Record<string, unknown>[] }).nodes) {
        const rollup = (node.commit as Record<string, unknown>).statusCheckRollup;
        if (isRecord(rollup)) paged(rollup.contexts, "hasNextPage");
      }
      return pr as unknown as PullRequestNode;
    },
  };
}
