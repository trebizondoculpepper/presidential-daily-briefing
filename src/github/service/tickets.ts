/**
 * Ticket guard and pull-request state reads for the typed GH service (#942). The GraphQL
 * documents and their validation live here; the claim workflow consumes typed answers only.
 */
/** The caller's GraphQL executor (structurally the claim workflow's `GraphQuery`). */
type GraphQuery = (query: string, variables: Record<string, string | number>) => Promise<unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/**
 * A fingerprint of the ticket's guarded state (state, labels, assignees, comment count) for a
 * throttled write's fresh-state guard (#345). Any malformed answer throws, so the guard fails and
 * the write is not retried; it never compares a partial read as unchanged.
 */
export async function ticketGuardState(
  query: GraphQuery,
  repository: string,
  number: number,
): Promise<string> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){state labels(first:100){totalCount nodes{name}} assignees(first:20){nodes{login}} comments{totalCount}}}}`,
    { owner: owner ?? "", name: name ?? "", number },
  );
  const repo = isRecord(data) ? data.repository : null;
  const issue = isRecord(repo) ? repo.issue : null;
  if (!isRecord(issue)) throw new Error("ticket unreadable");
  const labels = isRecord(issue.labels) ? issue.labels : null;
  const assignees = isRecord(issue.assignees) ? issue.assignees : null;
  const comments = isRecord(issue.comments) ? issue.comments : null;
  if (
    typeof issue.state !== "string" ||
    !labels ||
    !int(labels.totalCount) ||
    !Array.isArray(labels.nodes) ||
    !labels.nodes.every((l) => isRecord(l) && typeof l.name === "string") ||
    !assignees ||
    !Array.isArray(assignees.nodes) ||
    !assignees.nodes.every((a) => isRecord(a) && typeof a.login === "string") ||
    !comments ||
    !int(comments.totalCount)
  )
    throw new Error("ticket unreadable");
  return JSON.stringify([
    issue.state,
    labels.totalCount,
    (labels.nodes as { name: string }[]).map((l) => l.name).sort(),
    (assignees.nodes as { login: string }[]).map((a) => a.login).sort(),
    comments.totalCount,
  ]);
}

/** The live state of a pull request by URL; null when it is not a readable pull request. */
export async function pullStateByUrl(query: GraphQuery, url: string): Promise<string | null> {
  try {
    const data = await query(
      `query($url:URI!){resource(url:$url){__typename ... on PullRequest{state}}}`,
      {
        url,
      },
    );
    const resource = isRecord(data) ? data.resource : null;
    return isRecord(resource) &&
      resource.__typename === "PullRequest" &&
      typeof resource.state === "string"
      ? resource.state
      : null;
  } catch {
    return null;
  }
}

/** The ticket capabilities as one object: the facade's `tickets` group. */
export interface TicketReads {
  /** A fingerprint of the ticket's guarded state; throws when it cannot be read whole. */
  guardState(repository: string, number: number): Promise<string>;
  /** A pull request's live state by URL, or null when it is not a readable pull request. */
  pullStateByUrl(url: string): Promise<string | null>;
}

/** Ticket capabilities over one GraphQL executor (the facade's own, or a caller's counted one). */
export function ticketReads(query: GraphQuery): TicketReads {
  return {
    guardState: (repository, number) => ticketGuardState(query, repository, number),
    pullStateByUrl: (url) => pullStateByUrl(query, url),
  };
}
