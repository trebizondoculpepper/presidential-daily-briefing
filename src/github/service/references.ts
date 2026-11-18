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

/** Resolve `number` in `repository`; null when absent, unseen or malformed (never guessed). */
export async function resolveReference(
  query: Query,
  repository: string,
  number: number,
): Promise<Resolved | null> {
  const [owner, name] = repository.split("/");
  const data = await query(referenceQuery, { owner: owner!, name: name!, number });
  const repo = isRecord(data) ? data.repository : null;
  const node = isRecord(repo) ? repo.issueOrPullRequest : null;
  if (!isRecord(node) || !int(node.number) || !str(node.url) || !str(node.state)) return null;
  if (node.__typename === "Issue")
    return {
      __typename: "Issue",
      number: node.number,
      url: node.url,
      state: node.state,
      stateReason: str(node.stateReason) ? node.stateReason : null,
    };
  if (node.__typename !== "PullRequest" || typeof node.merged !== "boolean") return null;
  const refs = isRecord(node.closingIssuesReferences) ? node.closingIssuesReferences : null;
  return {
    __typename: "PullRequest",
    number: node.number,
    url: node.url,
    state: node.state,
    merged: node.merged,
    closingIssuesReferences: refs
      ? {
          nodes: (Array.isArray(refs.nodes) ? refs.nodes : []).flatMap((n) =>
            isRecord(n) &&
            int(n.number) &&
            str(n.url) &&
            str(n.state) &&
            isRecord(n.repository) &&
            str(n.repository.nameWithOwner)
              ? [
                  {
                    number: n.number,
                    url: n.url,
                    state: n.state,
                    repository: { nameWithOwner: n.repository.nameWithOwner },
                  },
                ]
              : [],
          ),
          ...(isRecord(refs.pageInfo) && typeof refs.pageInfo.hasNextPage === "boolean"
            ? { pageInfo: { hasNextPage: refs.pageInfo.hasNextPage } }
            : {}),
        }
      : null,
  };
}
