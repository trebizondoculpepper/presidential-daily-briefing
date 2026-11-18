/**
 * Reference resolution for the typed GH service (#922): a referenced number in a repository as
 * an issue, a pull request (with its closing references) or null when it does not exist or
 * cannot be seen. The GraphQL document and response validation live here.
 */

import type { Query } from "../github.js";

/** Resolve a referenced number to an issue, a pull request, or null (missing). */
export type Resolved =
  | { __typename: "Issue"; number: number; url: string; state: string; stateReason: string | null }
  | {
      __typename: "PullRequest";
      number: number;
      url: string;
      state: string;
      merged: boolean;
      closingIssuesReferences?: {
        nodes: {
          number: number;
          url: string;
          state: string;
          repository: { nameWithOwner: string };
        }[];
        pageInfo?: { hasNextPage: boolean };
      } | null;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

const referenceQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state stateReason} ... on PullRequest{number url state merged closingIssuesReferences(first:100){nodes{number url state repository{nameWithOwner}} pageInfo{hasNextPage}}}}}}`;

class MalformedReference extends Error {
  constructor(repository: string, number: number) {
    super(
      `GitHub returned a malformed answer for ${repository}#${number}; no migration plan was built from it.`,
    );
  }
}

/**
 * Resolve `number` in `repository`: null only when GitHub reports no such issue or pull request.
 * A present but malformed answer (including any unreadable closing reference or missing paging
 * evidence) is rejected, never filtered into a seemingly complete result.
 */
export async function resolveReference(
  query: Query,
  repository: string,
  number: number,
): Promise<Resolved | null> {
  const [owner, name] = repository.split("/");
  const data = await query(referenceQuery, { owner: owner!, name: name!, number });
  const repo = isRecord(data) ? data.repository : null;
  const node = isRecord(repo) ? repo.issueOrPullRequest : null;
  if (node === null || node === undefined) return null;
  if (!isRecord(node) || !int(node.number) || !str(node.url) || !str(node.state))
    throw new MalformedReference(repository, number);
  if (node.__typename === "Issue")
    return {
      __typename: "Issue",
      number: node.number,
      url: node.url,
      state: node.state,
      stateReason: str(node.stateReason) ? node.stateReason : null,
    };
  if (node.__typename !== "PullRequest" || typeof node.merged !== "boolean")
    throw new MalformedReference(repository, number);
  const refs = node.closingIssuesReferences;
  if (refs !== null && refs !== undefined) {
    const nodes = isRecord(refs) && Array.isArray(refs.nodes) ? refs.nodes : null;
    const paged =
      isRecord(refs) && isRecord(refs.pageInfo) && typeof refs.pageInfo.hasNextPage === "boolean";
    const valid = (n: unknown) =>
      isRecord(n) &&
      int(n.number) &&
      str(n.url) &&
      str(n.state) &&
      isRecord(n.repository) &&
      str(n.repository.nameWithOwner);
    if (!nodes || !paged || !nodes.every(valid)) throw new MalformedReference(repository, number);
  }
  return {
    __typename: "PullRequest",
    number: node.number,
    url: node.url,
    state: node.state,
    merged: node.merged,
    closingIssuesReferences:
      refs === null || refs === undefined
        ? null
        : (() => {
            // Validated above: every node and the paging evidence are present and well-formed.
            const r = refs as {
              nodes: {
                number: number;
                url: string;
                state: string;
                repository: { nameWithOwner: string };
              }[];
              pageInfo: { hasNextPage: boolean };
            };
            return {
              nodes: r.nodes.map((n) => ({
                number: n.number,
                url: n.url,
                state: n.state,
                repository: { nameWithOwner: n.repository.nameWithOwner },
              })),
              pageInfo: { hasNextPage: r.pageInfo.hasNextPage },
            };
          })(),
  };
}

/** One validated page of an issue's closing pull-request references (closed ones included). */
export interface ClosingReferencesPage {
  nodes: { number: number; url: string; state: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Read one page of an issue's closing references, closed pull requests included (#951). Throws
 * when the issue or page is unreadable or malformed, so the caller records the source as failed
 * rather than as an empty, complete list.
 */
export async function closingReferencesPage(
  query: Query,
  repository: string,
  number: number,
  perPage: number,
  cursor: string | null,
): Promise<ClosingReferencesPage> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:${perPage},includeClosedPrs:true,after:$cursor){nodes{number url state} pageInfo{hasNextPage endCursor}}}}}`,
    { owner: owner!, name: name!, number, ...(cursor ? { cursor } : {}) },
  );
  const repo = isRecord(data) ? data.repository : null;
  const issue = isRecord(repo) ? repo.issue : null;
  const page = isRecord(issue) ? issue.closedByPullRequestsReferences : null;
  const info = isRecord(page) && isRecord(page.pageInfo) ? page.pageInfo : null;
  if (
    !isRecord(page) ||
    !Array.isArray(page.nodes) ||
    !page.nodes.every(
      (n) =>
        isRecord(n) &&
        typeof n.number === "number" &&
        Number.isSafeInteger(n.number) &&
        typeof n.url === "string" &&
        typeof n.state === "string",
    ) ||
    !info ||
    typeof info.hasNextPage !== "boolean" ||
    (info.endCursor !== null && typeof info.endCursor !== "string")
  )
    throw new Error("closing references not readable");
  return {
    nodes: page.nodes as ClosingReferencesPage["nodes"],
    pageInfo: {
      hasNextPage: info.hasNextPage,
      endCursor: (info.endCursor as string | null) ?? null,
    },
  };
}
