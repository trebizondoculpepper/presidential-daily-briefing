/**
 * `pdb issue create` (#199, doc/design/issue-creation.md): create one issue in an explicitly
 * resolved repository with a correlation marker and an honest outcome. Transport-neutral: every
 * GitHub, clock, ID and input boundary is injected. One POST per invocation at most; never an
 * automatic retry, cleanup or label creation.
 */
import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { isAgentName } from "../config/identity.js";
import type { HumanContext } from "../config/humancontext.js";
import { shellQuote } from "./claims.js";
import type { FailureClassification } from "../github/evidence.js";
import type { Rest } from "../github/github.js";
import { ghPost, issueCapabilities } from "../github/service/issues.js";
import type {
  IssueCapabilities,
  IssueCreateOutcome,
  IssueReadResult,
  RestPost,
} from "../github/service/issues.js";

export type { PostAnswer, RestPost } from "../github/service/issues.js";

export const ISSUE_CREATE_MARKER = "github-triage:issue-create v1";
export const MAX_TITLE_CODE_POINTS = 256;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LABELS = 20;
export const MAX_LABEL_CODE_POINTS = 50;

export const issueCreateUsage =
  "Usage: pdb issue create --title TEXT [--body TEXT | --body-file PATH|-] [--label LABEL]... [--assignee LOGIN]... [--repo owner/name] [--agent NAME] [--dry-run] [--json]";

export const issueCreateHelp = `${issueCreateUsage}

Create one issue in a verified PDB-managed repository checkout. Without --repo the current gh
checkout's repository is used; the resolved target (canonical name and immutable ID) and verified
policy context are checked before writing. New issues default to the creating/employing human as
assignee (human ownership, not an automatic agent claim).
  --title TEXT       Required; one line, at most ${MAX_TITLE_CODE_POINTS} characters
  --body TEXT        Issue body text, or
  --body-file PATH   Read the body from a file; - reads standard input (not both with --body)
  --label LABEL      Repeatable, at most ${MAX_LABELS}; each must already exist (never created).
                     GitHub may drop labels you lack permission to set: reported as partial
  --assignee LOGIN   Repeatable; override the default creating-human assignee
  --repo owner/name  Target repository (default: the current checkout)
  --agent NAME       Reported agent, recorded as provenance only (never authority or a claim)
  --dry-run          Resolve and validate; show target, title, body, labels and assignees; no write
  --json             One versioned JSON document on stdout

Arguments are passed to gh as data, never through a shell. The body gets a hidden marker
(${ISSUE_CREATE_MARKER}) with an operation ID, the target ID and a digest of title, body and
labels; it is a correlation receipt, not a claim, approval or signature. No status, claim or
agent label is added. The issue writer never changes local checkout settings or identity. Normal CLI preparation
may first reuse or safely initialize the selected local agent (see pdb --help).

Retries: exactly one create request is sent per invocation and none is ever retried
automatically. After a timeout, 5xx or lost reply the outcome is "unknown": inspect the target's
recent issues for the operation ID before running the command again. Two separate invocations
are separate intents and can create duplicates; there is no exactly-once guarantee.

Status: planned (dry-run), created (verified), partial (issue exists, a requested detail such
as a label is missing), unknown (the request may have been committed), refused (nothing created).
Exit: 0 planned/created; 2 partial/unknown; 1 invalid input or refused.
`;

export type TargetCreationContext =
  | { verified: true; repository: string; defaultLabels?: readonly string[] }
  | { verified: false; reason: string };

export interface IssueCreateRuntime {
  /** Typed GH issue creation and read-back capabilities (#887). */
  issues?: IssueCapabilities;
  /** Legacy REST boundary (preserved while callers migrate to `issues`). */
  rest?: Rest;
  /** Legacy POST boundary (preserved while callers migrate to `issues`). */
  post?: RestPost;
  currentRepository: () => Promise<string>;
  now: () => Date;
  operationId: () => string;
  readFile: (path: string) => Promise<Uint8Array>;
  readStdin: () => Promise<Uint8Array>;
  /** Preflight diagnostics (text mode only); never stdout. */
  stderr: (text: string) => void;
  /** Verify local checkout and PDB policy context for the target repository (#666). */
  targetContext?: (repository: string) => Promise<TargetCreationContext>;
  /** Resolved employing human (#664); falls back to the authenticated viewer login. */
  employingHuman?: () => Promise<HumanContext>;
}

export interface IssueCreateRequest {
  title: string;
  body?: string;
  bodyFile?: string;
  labels: string[];
  assignees?: string[];
  repo?: string;
  agent?: string;
  dryRun: boolean;
  json: boolean;
}

export type IssueCreateStatus = "planned" | "created" | "partial" | "unknown" | "refused";

export interface IssueCreateResult {
  schemaVersion: 1;
  kind: "issue-create";
  operationId: string;
  startedAt: string;
  status: IssueCreateStatus;
  dryRun: boolean;
  requestedRepository: string | null;
  target: { repository: string; id: number; nodeId: string; url: string } | null;
  viewer: string | null;
  agent: string | null;
  title: string;
  issue: { number: number; nodeId: string; url: string } | null;
  labels: { requested: string[]; applied: string[] | null };
  assignees: { requested: string[]; applied: string[] | null };
  error: { id: string; message: string; evidence?: FailureClassification } | null;
  warnings: string[];
  recovery: string[];
  /** Dry-run only: the exact body that would be sent, including the marker. */
  preview?: { body: string; bodyBytes: number };
}

export class IssueCreateUsageError extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_ASSIGNEES = 10;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const codePoints = (text: string) => Array.from(text).length;

function normalizeLabels(rawLabels: readonly string[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawLabels) {
    const label = raw.trim();
    if (!label || CONTROL.test(label) || codePoints(label) > MAX_LABEL_CODE_POINTS)
      throw new IssueCreateUsageError(
        `Invalid --label: labels are 1-${MAX_LABEL_CODE_POINTS} characters without control characters.`,
      );
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  if (labels.length > MAX_LABELS)
    throw new IssueCreateUsageError(`At most ${MAX_LABELS} distinct labels.`);
  return labels;
}

function normalizeAssignees(rawAssignees: readonly string[]): string[] {
  const assignees: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawAssignees) {
    const login = raw.trim();
    if (!GITHUB_LOGIN.test(login))
      throw new IssueCreateUsageError("Invalid --assignee: must be a valid GitHub login.");
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    assignees.push(login);
  }
  if (assignees.length > MAX_ASSIGNEES)
    throw new IssueCreateUsageError(`At most ${MAX_ASSIGNEES} distinct assignees.`);
  return assignees;
}

/** Validate parsed flags; every refusal here happens before any GitHub request. */
export function validateRequest(request: IssueCreateRequest): IssueCreateRequest {
  const title = request.title;
  if (!title.trim()) throw new IssueCreateUsageError("--title must not be empty.");
  if (CONTROL.test(title))
    throw new IssueCreateUsageError("--title must be one line without control characters.");
  if (codePoints(title) > MAX_TITLE_CODE_POINTS)
    throw new IssueCreateUsageError(`--title exceeds ${MAX_TITLE_CODE_POINTS} characters.`);
  if (request.body !== undefined && request.bodyFile !== undefined)
    throw new IssueCreateUsageError("Pass either --body or --body-file, not both.");
  if (request.repo !== undefined && !REPO.test(request.repo))
    throw new IssueCreateUsageError("--repo must be owner/name.");
  if (request.agent !== undefined && !isAgentName(request.agent))
    throw new IssueCreateUsageError("--agent must be a valid agent name.");
  const labels = normalizeLabels(request.labels);
  const assignees =
    request.assignees !== undefined ? normalizeAssignees(request.assignees) : undefined;
  return { ...request, labels, ...(assignees !== undefined ? { assignees } : {}) };
}

/** Read the body: text, a file or stdin, decoded as strict UTF-8 and bounded. */
async function readBody(request: IssueCreateRequest, rt: IssueCreateRuntime): Promise<string> {
  if (request.bodyFile === undefined) return request.body ?? "";
  let bytes: Uint8Array;
  try {
    bytes = request.bodyFile === "-" ? await rt.readStdin() : await rt.readFile(request.bodyFile);
  } catch (error) {
    if (error instanceof IssueCreateUsageError) throw error;
    // Never echo the path's contents or the system error text.
    throw new IssueCreateUsageError("Cannot read --body-file.");
  }
  if (bytes.byteLength > MAX_BODY_BYTES)
    throw new IssueCreateUsageError(`The body exceeds ${MAX_BODY_BYTES} bytes.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IssueCreateUsageError("--body-file is not valid UTF-8 text.");
  }
}

/** Digest of the user's intent: exact title, exact user body, requested labels and assignees. */
export function intentDigest(
  title: string,
  body: string,
  labels: readonly string[],
  assignees: readonly string[] = [],
): string {
  const parts =
    assignees.length > 0
      ? [title, body, [...labels].sort(), [...assignees].sort()]
      : [title, body, [...labels].sort()];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The appended correlation marker. Every value is validated, so it cannot close the comment. */
export function creationMarker(fields: {
  operationId: string;
  repository: string;
  repositoryId: string;
  digest: string;
  agent?: string;
}): string {
  const data = {
    v: 1,
    op: fields.operationId,
    repo: fields.repository,
    repoId: fields.repositoryId,
    digest: fields.digest,
    ...(fields.agent ? { agent: fields.agent } : {}),
  };
  return `<!-- ${ISSUE_CREATE_MARKER} ${JSON.stringify(data)} -->`;
}

export const defaultOperationId = (): string => randomBytes(8).toString("hex");

/** Run one creation. Throws IssueCreateUsageError for invalid input (nothing requested). */
export async function createIssue(
  input: IssueCreateRequest,
  rt: IssueCreateRuntime,
): Promise<IssueCreateResult> {
  const request = validateRequest(input);
  const userBody = await readBody(request, rt);
  const operationId = rt.operationId();
  const startedAt = rt.now().toISOString();
  const result: IssueCreateResult = {
    schemaVersion: 1,
    kind: "issue-create",
    operationId,
    startedAt,
    status: "refused",
    dryRun: request.dryRun,
    requestedRepository: null,
    target: null,
    viewer: null,
    agent: request.agent ?? null,
    title: request.title,
    issue: null,
    labels: { requested: request.labels, applied: null },
    assignees: { requested: request.assignees ?? [], applied: null },
    error: null,
    warnings: [],
    recovery: [],
  };
  const refuse = (id: string, message: string, evidence?: FailureClassification) => {
    result.status = "refused";
    result.error = { id, message, ...(evidence ? { evidence } : {}) };
    return result;
  };
  // Target: explicit --repo wins; otherwise the verified current checkout (fails with guidance).
  const requested = request.repo ?? (await rt.currentRepository());
  if (!REPO.test(requested)) return refuse("TARGET_INVALID", "The target must be owner/name.");
  result.requestedRepository = requested;

  const issues: IssueCapabilities =
    rt.issues ??
    issueCapabilities(rt.rest ?? (async () => ({ status: 500, body: null })), rt.post ?? ghPost);
  const readRefusal = (answer: Extract<IssueReadResult<unknown>, { ok: false }>, what: string) => {
    if (answer.unverified)
      return refuse("TARGET_UNVERIFIED", "GitHub returned no verifiable repository identity.");
    const evidence = answer.evidence;
    const category = evidence?.category;
    if (category === "rate-limited" || category === "secondary-rate-limit")
      return refuse(
        "QUOTA",
        `GitHub rate limited the ${what} read; nothing was created. Retry after the reported reset.`,
        evidence,
      );
    if (answer.status === 401 || category === "authentication")
      return refuse(
        "AUTHENTICATION",
        "GitHub refused the gh login. Run gh auth status, then retry.",
        evidence,
      );
    if (answer.status === 404 || answer.status === 403 || category === "access")
      return refuse(
        "INACCESSIBLE",
        `${requested} is not accessible to this gh login (missing, private or forbidden); nothing was created.`,
        evidence,
      );
    return refuse(
      "UNAVAILABLE",
      `The ${what} could not be read (timeout or GitHub error); nothing was created.`,
      evidence,
    );
  };

  const repoResult = await issues.readRepository(requested);
  if (!repoResult.ok) return readRefusal(repoResult, "repository");
  const {
    fullName,
    id,
    nodeId,
    url: htmlUrl,
    archived,
    hasIssues,
    pushPermission,
  } = repoResult.value;
  // gh follows rename/transfer redirects; a different canonical name is never accepted silently.
  if (fullName.toLowerCase() !== requested.toLowerCase())
    return refuse(
      "TARGET_REDIRECTED",
      `${requested} now resolves to ${fullName}. Re-run with --repo ${fullName} if that is the intended repository.`,
    );
  result.target = {
    repository: fullName,
    id,
    nodeId,
    url: htmlUrl,
  };
  if (archived) return refuse("ARCHIVED", `${fullName} is archived; issues cannot be created.`);
  if (!hasIssues) return refuse("ISSUES_DISABLED", `Issues are disabled on ${fullName}.`);

  const viewerResult = await issues.readViewer();
  if (!viewerResult.ok) return readRefusal(viewerResult, "authenticated user");
  const login = viewerResult.value;
  result.viewer = login;

  // Require verified target checkout/policy context (#666); unfamiliar/unmanaged/no-checkout
  // reporting receives ordinary gh guidance instead of importing another project's defaults.
  const context = rt.targetContext
    ? await rt.targetContext(fullName)
    : {
        verified: false as const,
        reason: `No verified local checkout or PDB policy context for ${fullName}.`,
      };
  if (!context.verified || context.repository.toLowerCase() !== fullName.toLowerCase()) {
    const reason = !context.verified
      ? context.reason
      : `Verified checkout (${context.repository}) does not match ${fullName}.`;
    const ghArgs = [
      "gh",
      "issue",
      "create",
      "--repo",
      fullName,
      "--title",
      request.title,
      ...(request.bodyFile !== undefined && request.bodyFile !== "-"
        ? ["--body-file", request.bodyFile]
        : userBody
          ? ["--body-file", "<path-to-body-file>"]
          : []),
      ...request.labels.flatMap((l) => ["--label", l]),
      ...(request.assignees ?? []).flatMap((a) => ["--assignee", a]),
    ];
    result.recovery = [ghArgs.map(shellQuote).join(" ")];
    return refuse(
      "UNVERIFIED_TARGET_CONTEXT",
      `${reason} For unfamiliar, unmanaged, or no-checkout issue reporting, use ordinary gh instead of borrowing another checkout's PDB policy.`,
    );
  }

  const effectiveLabels = normalizeLabels([...(context.defaultLabels ?? []), ...request.labels]);
  result.labels.requested = effectiveLabels;

  // Default assignee is the resolved creating/employing human; explicit --assignee overrides it.
  // Human ownership is never an automatic agent claim.
  let effectiveAssignees: string[];
  if (request.assignees !== undefined) {
    effectiveAssignees = request.assignees;
  } else {
    const human = rt.employingHuman ? await rt.employingHuman().catch(() => null) : null;
    const creatingHuman =
      human?.state === "current" && human.login && GITHUB_LOGIN.test(human.login)
        ? human.login
        : login;
    effectiveAssignees = [creatingHuman];
  }
  result.assignees.requested = effectiveAssignees;

  // Labels: each must exist (this command never creates one). Setting labels needs push access;
  // GitHub otherwise drops them, which is disclosed now and verified after creation.
  for (const label of effectiveLabels) {
    const labelResult = await issues.hasLabel(fullName, label);
    if (!labelResult.ok) return readRefusal(labelResult, "label");
    if (!labelResult.value)
      return refuse(
        "LABEL_MISSING",
        `Label ${JSON.stringify(label)} does not exist on ${fullName}; this command never creates labels.`,
      );
  }
  if ((effectiveLabels.length || effectiveAssignees.length) && pushPermission !== true)
    result.warnings.push(
      pushPermission === false
        ? `${login} lacks push access to ${fullName}; GitHub may create the issue without the requested labels or assignees.`
        : `Could not confirm label/assignee permission on ${fullName}; labels and assignees are verified after creation.`,
    );

  const marker = creationMarker({
    operationId,
    repository: fullName,
    repositoryId: nodeId,
    digest: intentDigest(request.title, userBody, effectiveLabels, effectiveAssignees),
    ...(request.agent ? { agent: request.agent } : {}),
  });
  const body = userBody ? `${userBody}\n\n${marker}` : marker;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
    return refuse("BODY_TOO_LARGE", `The body with its marker exceeds ${MAX_BODY_BYTES} bytes.`);

  // Every displayed command is POSIX-quoted per argument; no value reaches a shell unquoted.
  const recovery = [
    [
      "gh",
      "api",
      `repos/${fullName}/issues?creator=${login}&since=${startedAt}&state=all&per_page=30`,
      "--jq",
      `.[] | select(.body | contains("${operationId}")) | .html_url`,
    ]
      .map(shellQuote)
      .join(" "),
  ];
  if (request.dryRun) {
    result.status = "planned";
    result.preview = { body, bodyBytes: Buffer.byteLength(body, "utf8") };
    result.warnings.push("Dry run: nothing was created; the operation ID is not a reservation.");
    return result;
  }
  if (!request.json)
    rt.stderr(
      `pdb issue create: creating in ${fullName} (${nodeId}) as ${login}, operation ${operationId}\n`,
    );

  const payload = {
    title: request.title,
    body,
    ...(effectiveLabels.length ? { labels: effectiveLabels } : {}),
    ...(effectiveAssignees.length ? { assignees: effectiveAssignees } : {}),
  };
  let outcome: IssueCreateOutcome;
  try {
    outcome = await issues.create(fullName, payload);
  } catch {
    outcome = { kind: "unknown", reason: "transport", status: null };
  }
  const unknown = (message: string, evidence?: FailureClassification) => {
    result.status = "unknown";
    result.error = {
      id: "OUTCOME_UNKNOWN",
      message,
      ...(evidence ? { evidence } : {}),
    };
    result.recovery = [
      ...recovery,
      `Look for operation ${operationId} in issues ${login} created on ${fullName} since ${startedAt}. Do not re-run unless no issue carries it; a bounded search cannot prove absence.`,
    ];
    return result;
  };
  if (outcome.kind === "not-dispatched")
    return refuse("NOT_DISPATCHED", "The create request was not sent; nothing was created.");
  if (outcome.kind === "unknown") {
    if (outcome.reason === "transport")
      return unknown(
        "The create request was sent but no definitive answer arrived (timeout, lost reply or server error); the issue may exist.",
        outcome.evidence,
      );
    if (outcome.reason === "unexpected-status")
      return unknown(
        `GitHub answered HTTP ${outcome.status}, which does not prove creation.`,
        outcome.evidence,
      );
    if (outcome.reason === "malformed")
      return unknown(
        "GitHub answered 201 without a verifiable issue identity; the issue may exist.",
      );
    if (outcome.mismatchedUrl)
      result.warnings.push(
        `GitHub reported an issue outside the intended target: ${outcome.mismatchedUrl}`,
      );
    return unknown(
      "The created issue does not match the intended target; not reported as created.",
    );
  }
  if (outcome.kind === "refused") {
    const category = outcome.evidence?.category;
    if (
      category === "rate-limited" ||
      category === "secondary-rate-limit" ||
      outcome.status === 429
    )
      return refuse(
        "QUOTA",
        "GitHub rate limited the create request; nothing was created. Retry after the reported reset.",
        outcome.evidence,
      );
    if (outcome.status === 401)
      return refuse("AUTHENTICATION", "GitHub refused the gh login.", outcome.evidence);
    if (outcome.status === 410)
      return refuse("ISSUES_DISABLED", `Issues are disabled on ${fullName}.`, outcome.evidence);
    if (outcome.status === 403 || outcome.status === 404)
      return refuse(
        "PERMISSION",
        `GitHub refused issue creation on ${fullName} for ${login}.`,
        outcome.evidence,
      );
    if (outcome.status === 422)
      return refuse(
        "REJECTED",
        "GitHub rejected the issue content (validation failed).",
        outcome.evidence,
      );
    return refuse(
      "REJECTED",
      `GitHub refused the request (HTTP ${outcome.status}).`,
      outcome.evidence,
    );
  }
  const { number, nodeId: issueNode, url: issueUrl } = outcome.issue;
  result.issue = { number, nodeId: issueNode, url: issueUrl };
  let appliedLabels = outcome.issue.labels;
  let appliedAssignees = outcome.issue.assignees;
  const missingFrom = (wanted: readonly string[], have: readonly string[]) =>
    wanted.filter((w) => !have.some((h) => h.toLowerCase() === w.toLowerCase()));
  const needsLabelRead =
    effectiveLabels.length > 0 &&
    (appliedLabels === null || missingFrom(effectiveLabels, appliedLabels).length > 0);
  const needsAssigneeRead =
    effectiveAssignees.length > 0 &&
    (appliedAssignees === null || missingFrom(effectiveAssignees, appliedAssignees).length > 0);
  if (needsLabelRead || needsAssigneeRead) {
    // One bounded read-back before reporting labels or assignees missing.
    const back = await issues.readBack(fullName, number, issueNode);
    if (back?.labels) appliedLabels = back.labels;
    else if (needsLabelRead)
      result.warnings.push("Read-back of the created issue failed; label state is unverified.");
    if (back?.assignees) appliedAssignees = back.assignees;
    else if (needsAssigneeRead)
      result.warnings.push("Read-back of the created issue failed; assignee state is unverified.");
  }
  // Unknown stays null: an unread label or assignee list is never reported as empty.
  result.labels.applied = appliedLabels;
  result.assignees.applied = appliedAssignees;

  const labelsUnverified = effectiveLabels.length > 0 && appliedLabels === null;
  const assigneesUnverified = effectiveAssignees.length > 0 && appliedAssignees === null;
  const absentLabels = appliedLabels ? missingFrom(effectiveLabels, appliedLabels) : [];
  const absentAssignees = appliedAssignees ? missingFrom(effectiveAssignees, appliedAssignees) : [];

  if (labelsUnverified || assigneesUnverified || absentLabels.length || absentAssignees.length) {
    result.status = "partial";
    const missingParts: string[] = [];
    if (absentLabels.length) missingParts.push(`labels: ${absentLabels.join(", ")}`);
    if (absentAssignees.length) missingParts.push(`assignees: ${absentAssignees.join(", ")}`);
    const unverifiedParts: string[] = [];
    if (labelsUnverified) unverifiedParts.push("labels");
    if (assigneesUnverified) unverifiedParts.push("assignees");
    if (absentLabels.length && !absentAssignees.length && !assigneesUnverified) {
      result.error = {
        id: "LABELS_MISSING",
        message: `Issue created, but GitHub did not apply: ${absentLabels.join(", ")}. Do not create it again.`,
      };
    } else if (absentAssignees.length && !absentLabels.length && !labelsUnverified) {
      result.error = {
        id: "ASSIGNMENT_MISSING",
        message: `Issue created, but GitHub omitted assignee(s): ${absentAssignees.join(", ")}. Inspect ${issueUrl}; do not create it again.`,
      };
    } else if (labelsUnverified && !assigneesUnverified && !absentAssignees.length) {
      result.error = {
        id: "LABELS_UNVERIFIED",
        message: `Issue created, but whether GitHub applied the requested labels is unknown. Inspect ${issueUrl}; do not create it again.`,
      };
    } else if (assigneesUnverified && !labelsUnverified && !absentLabels.length) {
      result.error = {
        id: "ASSIGNMENT_UNVERIFIED",
        message: `Issue created, but whether GitHub applied the requested assignees is unknown. Inspect ${issueUrl}; do not create it again.`,
      };
    } else {
      const details = [
        ...(missingParts.length ? [`missing ${missingParts.join("; ")}`] : []),
        ...(unverifiedParts.length ? [`unverified ${unverifiedParts.join(" and ")}`] : []),
      ].join("; ");
      result.error = {
        id: absentLabels.length || absentAssignees.length ? "PARTIAL_APPLY" : "PARTIAL_UNVERIFIED",
        message: `Issue created, but ${details}. Inspect ${issueUrl}; do not create it again.`,
      };
    }
    // gh issue edit splits on commas; REST calls take exact names as JSON on stdin.
    if (absentLabels.length)
      result.recovery.push(
        `${["gh", "api", "--method", "POST", `repos/${fullName}/issues/${number}/labels`, "--input", "-"].map(shellQuote).join(" ")} <<'PDB_LABELS'\n${JSON.stringify({ labels: absentLabels })}\nPDB_LABELS`,
      );
    if (absentAssignees.length)
      result.recovery.push(
        `${["gh", "api", "--method", "POST", `repos/${fullName}/issues/${number}/assignees`, "--input", "-"].map(shellQuote).join(" ")} <<'PDB_ASSIGNEES'\n${JSON.stringify({ assignees: absentAssignees })}\nPDB_ASSIGNEES`,
      );
    return result;
  }
  result.status = "created";
  return result;
}

export const issueCreateExitCode = (result: IssueCreateResult): number =>
  result.status === "planned" || result.status === "created"
    ? 0
    : result.status === "partial" || result.status === "unknown"
      ? 2
      : 1;

/** Human text describing the same outcome as the JSON. */
export function issueCreateText(result: IssueCreateResult): string {
  const lines = [
    `Issue create ${result.status}${result.dryRun ? " (dry run)" : ""}: operation ${result.operationId}`,
  ];
  if (result.target)
    lines.push(
      `Target: ${result.target.repository} (${result.target.nodeId}) ${result.target.url}`,
    );
  else if (result.requestedRepository)
    lines.push(`Requested target: ${result.requestedRepository}`);
  if (result.viewer)
    lines.push(`As: ${result.viewer}${result.agent ? ` (agent ${result.agent})` : ""}`);
  lines.push(`Title: ${JSON.stringify(result.title)}`);
  if (result.labels.requested.length)
    lines.push(
      `Labels: ${result.labels.requested.join(", ")}${result.labels.applied ? ` (applied: ${result.labels.applied.join(", ") || "none"})` : ""}`,
    );
  if (result.assignees.requested.length)
    lines.push(
      `Assignees: ${result.assignees.requested.join(", ")}${result.assignees.applied ? ` (applied: ${result.assignees.applied.join(", ") || "none"})` : ""}`,
    );
  if (result.issue) lines.push(`Issue: #${result.issue.number} ${result.issue.url}`);
  if (result.preview) lines.push(`Body (${result.preview.bodyBytes} bytes):`, result.preview.body);
  if (result.error) lines.push(`${result.error.id}: ${result.error.message}`);
  for (const w of result.warnings) lines.push(`Warning: ${w}`);
  for (const r of result.recovery) lines.push(`Recovery: ${r}`);
  return lines.join("\n") + "\n";
}

/** Bounded stdin read: stops reading just past the body limit. */
export async function readStdinBounded(
  stream: AsyncIterable<unknown> = process.stdin,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new IssueCreateUsageError(`The body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  return Buffer.concat(chunks);
}

/** Bounded file read: refuses by size before loading, and never reads past the limit. */
export async function defaultReadFile(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size > MAX_BODY_BYTES)
      throw new IssueCreateUsageError(`The body exceeds ${MAX_BODY_BYTES} bytes.`);
    const buffer = Buffer.alloc(MAX_BODY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BODY_BYTES)
      throw new IssueCreateUsageError(`The body exceeds ${MAX_BODY_BYTES} bytes.`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
