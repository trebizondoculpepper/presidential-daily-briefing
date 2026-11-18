/**
 * Typed GitHub estimation capabilities (#916, doc/design/github-service-composition.md).
 *
 * Encapsulates issue/label-definition/comment GraphQL reads, response validation, and
 * label/comment writes so `estimation/estimate.ts` does not compose GraphQL queries/mutations
 * or parse raw GraphQL shapes.
 */
import { classifyAddComment } from "../commentwrite.js";
import type { CommentAttempt } from "../commentwrite.js";
import { isRecord, prop } from "../github.js";
import type { GraphqlAnswer, GraphqlApi } from "../github.js";
import type { Comment } from "../../workflow/claims.js";

export interface EstimationLabelNode {
  readonly id: string;
  readonly name: string;
}

export interface EstimationCommentPage {
  readonly nodes: readonly Comment[] | null;
  readonly hasPreviousPage: boolean | null;
  readonly startCursor: string | null;
  readonly errors: readonly { type?: string; message?: string }[];
}

export interface EstimationIssueRead {
  readonly repositoryId: string | null;
  readonly issueId: string | null;
  readonly state: string | null;
  readonly lastEditedAt?: string | null;
  readonly labelDefinition: EstimationLabelNode | null;
  readonly labels: {
    readonly nodes: readonly EstimationLabelNode[] | null;
    readonly hasNextPage: boolean | null;
    readonly malformed: boolean;
  };
  readonly comments: EstimationCommentPage;
  readonly errors: readonly { type?: string; message?: string }[];
}

export interface EstimationCapabilities {
  readIssue(input: {
    owner: string;
    name: string;
    number: number;
    label: string;
    includeEdited: boolean;
  }): Promise<EstimationIssueRead>;
  readCommentsPage(input: {
    owner: string;
    name: string;
    number: number;
    before: string;
    includeEdited: boolean;
  }): Promise<EstimationCommentPage>;
  createLabel(input: {
    repositoryId: string;
    name: string;
    color: string;
    description: string;
  }): Promise<{
    label: EstimationLabelNode | null;
    errors: readonly { type?: string; message?: string }[];
  }>;
  addLabel(input: {
    issueId: string;
    labelId: string;
  }): Promise<{ ok: boolean; errors: readonly { type?: string; message?: string }[] }>;
  removeLabel(input: {
    issueId: string;
    labelId: string;
  }): Promise<{ ok: boolean; errors: readonly { type?: string; message?: string }[] }>;
  addComment(input: { issueId: string; body: string }): Promise<CommentAttempt>;
}

const commentNode =
  "body createdAt author { __typename login } lastEditedAt includesCreatedEdit editor { __typename login }";

const issueQuery = (
  number: number,
  includeEdited: boolean,
) => `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) { id label(name: $label) { id name }
    issue(number: ${number}) { id state ${includeEdited ? "lastEditedAt " : ""}labels(first: 100) { pageInfo { hasNextPage } nodes { id name } }
      comments(last: 100) { pageInfo { hasPreviousPage startCursor } nodes { ${commentNode} } } } } }`;

const commentsPageQuery = (
  number: number,
) => `query($owner: String!, $name: String!, $before: String!) {
  repository(owner: $owner, name: $name) { issue(number: ${number}) {
    comments(last: 100, before: $before) { pageInfo { hasPreviousPage startCursor } nodes { ${commentNode} } } } } }`;

const CREATE_LABEL = `mutation($repository: ID!, $name: String!, $color: String!, $description: String!) {
  createLabel(input: { repositoryId: $repository, name: $name, color: $color, description: $description }) {
    label { id name } } }`;
const ADD_LABEL = `mutation($issue: ID!, $label: ID!) {
  addLabelsToLabelable(input: { labelableId: $issue, labelIds: [$label] }) { clientMutationId } }`;
const REMOVE_LABEL = `mutation($issue: ID!, $label: ID!) {
  removeLabelsFromLabelable(input: { labelableId: $issue, labelIds: [$label] }) { clientMutationId } }`;
const ADD_COMMENT = `mutation($issue: ID!, $body: String!) {
  addComment(input: { subjectId: $issue, body: $body }) { commentEdge { node { url } } } }`;

const safely = (call: Promise<GraphqlAnswer>): Promise<GraphqlAnswer> =>
  call.catch((error: unknown) => ({ data: null, errors: [{ message: (error as Error).message }] }));

const labelNode = (value: unknown): EstimationLabelNode | null => {
  const id = prop(value, "id");
  const name = prop(value, "name");
  return typeof id === "string" && typeof name === "string" ? { id, name } : null;
};

const parseActor = (value: unknown): { __typename?: string; login?: string } | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.__typename === "string" ? { __typename: value.__typename } : {}),
    ...(typeof value.login === "string" ? { login: value.login } : {}),
  };
};

const parseCommentNode = (value: unknown): Comment => {
  const author = parseActor(prop(value, "author"));
  const editor = parseActor(prop(value, "editor"));
  return {
    body: typeof prop(value, "body") === "string" ? (prop(value, "body") as string) : "",
    createdAt:
      typeof prop(value, "createdAt") === "string" ? (prop(value, "createdAt") as string) : "",
    ...(author !== undefined ? { author } : {}),
    ...(typeof prop(value, "lastEditedAt") === "string" || prop(value, "lastEditedAt") === null
      ? { lastEditedAt: prop(value, "lastEditedAt") as string | null }
      : {}),
    ...(typeof prop(value, "includesCreatedEdit") === "boolean"
      ? { includesCreatedEdit: prop(value, "includesCreatedEdit") as boolean }
      : {}),
    ...(editor !== undefined ? { editor } : {}),
  };
};

const parseCommentPage = (
  comments: unknown,
  errors: readonly { type?: string; message?: string }[],
): EstimationCommentPage => {
  const rawNodes = prop(comments, "nodes");
  const hasPrev = prop(comments, "pageInfo", "hasPreviousPage");
  const startCursor = prop(comments, "pageInfo", "startCursor");
  return {
    nodes: Array.isArray(rawNodes) ? rawNodes.map(parseCommentNode) : null,
    hasPreviousPage: typeof hasPrev === "boolean" ? hasPrev : null,
    startCursor: typeof startCursor === "string" && startCursor ? startCursor : null,
    errors,
  };
};

/** Build typed estimation capabilities over a GraphQL API boundary. */
export function estimationCapabilities(api: GraphqlApi): EstimationCapabilities {
  return {
    async readIssue({ owner, name, number, label, includeEdited }) {
      const answer = await safely(
        api.query(issueQuery(number, includeEdited), { owner, name, label }),
      );
      const repository = prop(answer.data, "repository");
      const issue = prop(repository, "issue");
      const repositoryId = prop(repository, "id");
      const rawLabels = prop(issue, "labels", "nodes");
      const hasNext = prop(issue, "labels", "pageInfo", "hasNextPage");
      const edited = prop(issue, "lastEditedAt");
      let parsedLabels: EstimationLabelNode[] | null = null;
      let malformed = false;
      if (Array.isArray(rawLabels)) {
        parsedLabels = [];
        for (const node of rawLabels) {
          const parsed = labelNode(node);
          if (!parsed) {
            malformed = true;
            break;
          }
          parsedLabels.push(parsed);
        }
      }
      return {
        repositoryId: typeof repositoryId === "string" ? repositoryId : null,
        issueId: isRecord(issue) && typeof issue.id === "string" ? issue.id : null,
        state: isRecord(issue) && typeof issue.state === "string" ? issue.state : null,
        ...(includeEdited ? { lastEditedAt: typeof edited === "string" ? edited : null } : {}),
        labelDefinition: labelNode(prop(repository, "label")),
        labels: {
          nodes: parsedLabels,
          hasNextPage: typeof hasNext === "boolean" ? hasNext : null,
          malformed,
        },
        comments: parseCommentPage(prop(issue, "comments"), answer.errors),
        errors: answer.errors,
      };
    },

    async readCommentsPage({ owner, name, number, before }) {
      const answer = await safely(api.query(commentsPageQuery(number), { owner, name, before }));
      return parseCommentPage(prop(answer.data, "repository", "issue", "comments"), answer.errors);
    },

    async createLabel({ repositoryId, name, color, description }) {
      const created = await safely(
        api.mutate(CREATE_LABEL, { repository: repositoryId, name, color, description }),
      );
      return {
        label: labelNode(prop(created.data, "createLabel", "label")),
        errors: created.errors,
      };
    },

    async addLabel({ issueId, labelId }) {
      const add = await safely(api.mutate(ADD_LABEL, { issue: issueId, label: labelId }));
      return {
        ok: !add.errors.length && isRecord(prop(add.data, "addLabelsToLabelable")),
        errors: add.errors,
      };
    },

    async removeLabel({ issueId, labelId }) {
      const remove = await safely(api.mutate(REMOVE_LABEL, { issue: issueId, label: labelId }));
      return {
        ok: !remove.errors.length && isRecord(prop(remove.data, "removeLabelsFromLabelable")),
        errors: remove.errors,
      };
    },

    async addComment({ issueId, body }) {
      const comment = await safely(api.mutate(ADD_COMMENT, { issue: issueId, body }));
      return classifyAddComment(
        comment,
        prop(comment.data, "addComment", "commentEdge", "node", "url"),
      );
    },
  };
}
