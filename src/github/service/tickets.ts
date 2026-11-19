/**
 * Ticket reads for the typed GH service (#942). The GraphQL documents and their validation live
 * here; the claim workflow consumes typed answers only.
 */
/** The caller's GraphQL executor (structurally the claim workflow's `GraphQuery`). */
type GraphQuery = (query: string, variables: Record<string, string | number>) => Promise<unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export type TicketActor = { __typename?: string; login?: string };

export type TicketComment = {
  body: string;
  databaseId?: number;
  url?: string;
  createdAt?: string;
  author?: TicketActor | null;
  lastEditedAt?: string | null;
  includesCreatedEdit?: boolean;
  editor?: TicketActor | null;
};

export type TicketCommentPage = {
  nodes: TicketComment[];
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
};

export type TicketLabelEvent = {
  __typename?: string;
  createdAt?: string;
  label?: { name: string };
};

export type TicketHistoryEvent =
  | {
      __typename: "LabeledEvent" | "UnlabeledEvent";
      createdAt: string;
      label: { name: string };
      actor?: TicketActor | null;
    }
  | {
      __typename: "ClosedEvent";
      createdAt: string;
      stateReason?: string | null;
      actor?: TicketActor | null;
    }
  | { __typename: "ReopenedEvent"; createdAt: string; actor?: TicketActor | null };

export type TicketTimelinePage<E> = {
  nodes: E[];
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
};

export interface TicketIssueNode {
  __typename: "Issue";
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: { nodes: { name: string }[]; pageInfo?: { hasNextPage: boolean } };
  assignees?: {
    nodes: { __typename?: string; login?: string | null }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  issueDependenciesSummary: { blockedBy: number } | null;
  blockedBy: { nodes: { number: number; url: string; state: string }[] };
  closedByPullRequestsReferences: {
    nodes: { number: number; url: string; state: string }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: TicketCommentPage;
  timelineItems?: TicketTimelinePage<TicketLabelEvent>;
}

export type TicketItemNode =
  | TicketIssueNode
  | { __typename: "PullRequest"; number: number; url: string };

export interface TicketReadLabels {
  owner: string;
  question: string;
  decisionNeeded: string;
  needsDesign: string;
  attention: string;
  target?: string;
}

export interface TicketSnapshot {
  item: TicketItemNode | null;
  claims: { number: number; title: string; url: string }[];
  claimsComplete: boolean;
  repoLabels: Set<string>;
}

const commentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";
const labelEventFields =
  "__typename ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}}";
const actorFields = "actor{__typename login}";
const historyEventFields = `__typename ... on LabeledEvent{createdAt label{name} ${actorFields}} ... on UnlabeledEvent{createdAt label{name} ${actorFields}} ... on ClosedEvent{createdAt stateReason ${actorFields}} ... on ReopenedEvent{createdAt ${actorFields}}`;

const splitRepo = (repository: string): [string, string] => {
  const [owner, name] = repository.split("/");
  return [owner ?? "", name ?? ""];
};

async function timelinePage<E>(
  query: GraphQuery,
  repository: string,
  number: number,
  itemTypes: string,
  fields: string,
  before: string | null,
): Promise<TicketTimelinePage<E> | null> {
  const [owner, name] = splitRepo(repository);
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!${before ? ",$before:String!" : ""}){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(itemTypes:[${itemTypes}],last:100${before ? ",before:$before" : ""}){nodes{${fields}} pageInfo{hasPreviousPage startCursor}}}}}`,
    { owner, name, number, ...(before ? { before } : {}) },
  );
  const repo = isRecord(data) ? data.repository : null;
  const issue = isRecord(repo) ? repo.issue : null;
  const timeline = isRecord(issue) ? issue.timelineItems : null;
  if (!isRecord(timeline) || !Array.isArray(timeline.nodes)) return null;
  return timeline as unknown as TicketTimelinePage<E>;
}

async function readCommentPage(
  query: GraphQuery,
  repository: string,
  number: number,
  before: string,
): Promise<TicketCommentPage | null> {
  const [owner, name] = splitRepo(repository);
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$before:String!){repository(owner:$owner,name:$name){issue(number:$number){comments(last:100,before:$before){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
    { owner, name, number, before },
  );
  const repo = isRecord(data) ? data.repository : null;
  const issue = isRecord(repo) ? repo.issue : null;
  const comments = isRecord(issue) ? issue.comments : null;
  if (!isRecord(comments) || !Array.isArray(comments.nodes)) return null;
  return comments as unknown as TicketCommentPage;
}

async function readTicketSnapshot(
  query: GraphQuery,
  repository: string,
  number: number,
  labels: TicketReadLabels,
): Promise<TicketSnapshot> {
  const [owner, name] = splitRepo(repository);
  const target = labels.target ?? "";
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$label:String!,$question:String!,$decision:String!,$needsDesign:String!,$attention:String!${target ? ",$target:String!" : ""}){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{number url} ... on Issue{number title url state updatedAt labels(first:100){nodes{name} pageInfo{hasNextPage}} assignees(first:100){nodes{__typename login} pageInfo{hasNextPage}} issueDependenciesSummary{blockedBy} blockedBy(first:20){nodes{number url state}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}} timelineItems(itemTypes:[LABELED_EVENT,UNLABELED_EVENT],last:50){nodes{__typename ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}}} pageInfo{hasPreviousPage startCursor}}}} claims:issues(first:20,states:OPEN,labels:[$label]){nodes{number title url} pageInfo{hasNextPage}} ownerLabel:label(name:$label){name} questionLabel:label(name:$question){name} decisionLabel:label(name:$decision){name} needsDesignLabel:label(name:$needsDesign){name} attentionLabel:label(name:$attention){name}${target ? " targetLabel:label(name:$target){name}" : ""}}}`,
    {
      owner,
      name,
      number,
      label: labels.owner,
      question: labels.question,
      decision: labels.decisionNeeded,
      needsDesign: labels.needsDesign,
      attention: labels.attention,
      ...(target ? { target } : {}),
    },
  );
  const repo = isRecord(data) ? (data.repository as Record<string, unknown> | null) : null;
  if (!repo) throw new Error(`Repository unavailable: ${repository}`);
  if (repo.claims != null && (!isRecord(repo.claims) || !Array.isArray(repo.claims.nodes))) {
    throw new Error("GitHub returned a malformed claims list.");
  }
  const claims = isRecord(repo.claims) ? repo.claims : null;
  const claimNodes = claims
    ? (claims.nodes as { number: number; title: string; url: string }[])
    : [];
  const claimsPage = isRecord(claims?.pageInfo) ? claims.pageInfo : null;
  const labelName = (v: unknown): string | null =>
    isRecord(v) && typeof v.name === "string" ? v.name : null;
  return {
    item: (repo.issueOrPullRequest as TicketItemNode | null | undefined) ?? null,
    claims: claimNodes,
    claimsComplete: !!claims && !claimsPage?.hasNextPage,
    repoLabels: new Set(
      [
        labelName(repo.ownerLabel),
        labelName(repo.questionLabel),
        labelName(repo.decisionLabel),
        labelName(repo.needsDesignLabel),
        labelName(repo.attentionLabel),
        labelName(repo.targetLabel),
      ].filter((n): n is string => n !== null),
    ),
  };
}

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

async function readViewer(query: GraphQuery): Promise<TicketActor | null> {
  const data = await query("query{viewer{__typename login}}", {});
  const viewer = isRecord(data) ? data.viewer : null;
  return isRecord(viewer) ? (viewer as TicketActor) : null;
}

/** The ticket capabilities as one object: the facade's `tickets` group. */
export interface TicketReads {
  /** Authenticated viewer account (`__typename` and `login`). */
  viewer(): Promise<TicketActor | null>;
  /** A fingerprint of the ticket's guarded state; throws when it cannot be read whole. */
  guardState(repository: string, number: number): Promise<string>;
  /** A pull request's live state by URL, or null when it is not a readable pull request. */
  pullStateByUrl(url: string): Promise<string | null>;
  /** One page of label add/remove timeline events before `before` (or newest when null). */
  labelTimelinePage(
    repository: string,
    number: number,
    before: string | null,
  ): Promise<TicketTimelinePage<TicketLabelEvent> | null>;
  /** One page of label and closure timeline events before `before` (or newest when null). */
  historyTimelinePage(
    repository: string,
    number: number,
    before: string | null,
  ): Promise<TicketTimelinePage<TicketHistoryEvent> | null>;
  /** One older page of issue comments before `before`. */
  commentPage(
    repository: string,
    number: number,
    before: string,
  ): Promise<TicketCommentPage | null>;
  /** Live snapshot of one ticket, the agent's open claims, and known workflow labels. */
  readTicket(repository: string, number: number, labels: TicketReadLabels): Promise<TicketSnapshot>;
}

/** Ticket capabilities over one GraphQL executor (the facade's own, or a caller's counted one). */
export function ticketReads(query: GraphQuery): TicketReads {
  return {
    viewer: () => readViewer(query),
    guardState: (repository, number) => ticketGuardState(query, repository, number),
    pullStateByUrl: (url) => pullStateByUrl(query, url),
    labelTimelinePage: (repository, number, before) =>
      timelinePage<TicketLabelEvent>(
        query,
        repository,
        number,
        "LABELED_EVENT,UNLABELED_EVENT",
        labelEventFields,
        before,
      ),
    historyTimelinePage: (repository, number, before) =>
      timelinePage<TicketHistoryEvent>(
        query,
        repository,
        number,
        "LABELED_EVENT,UNLABELED_EVENT,CLOSED_EVENT,REOPENED_EVENT",
        historyEventFields,
        before,
      ),
    commentPage: (repository, number, before) => readCommentPage(query, repository, number, before),
    readTicket: (repository, number, labels) =>
      readTicketSnapshot(query, repository, number, labels),
  };
}
