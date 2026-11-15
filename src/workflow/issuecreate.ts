/**
 * `pdb issue create` (#199, doc/design/issue-creation.md): create one issue in an explicitly
 * resolved repository with a correlation marker and an honest outcome. Transport-neutral: every
 * GitHub, clock, ID and input boundary is injected. One POST per invocation at most; never an
 * automatic retry, cleanup or label creation.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAgentName } from "../config/identity.js";
import { shellQuote } from "./claims.js";
import { classifyGhFailure, parseGhResponse } from "../github/evidence.js";
import type { FailureClassification } from "../github/evidence.js";
import { isRecord, prop } from "../github/github.js";
import type { Rest, RestAnswer } from "../github/github.js";

export const ISSUE_CREATE_MARKER = "github-triage:issue-create v1";
export const MAX_TITLE_CODE_POINTS = 256;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LABELS = 20;
export const MAX_LABEL_CODE_POINTS = 50;

export const issueCreateUsage =
  "Usage: pdb issue create --title TEXT [--body TEXT | --body-file PATH|-] [--label LABEL]... [--repo owner/name] [--agent NAME] [--dry-run] [--json]";

export const issueCreateHelp = `${issueCreateUsage}

Create one issue in a resolved repository. Without --repo the current gh checkout's repository
is used; the resolved target (canonical name and immutable ID) is shown before writing.
  --title TEXT      Required; one line, at most ${MAX_TITLE_CODE_POINTS} characters
  --body TEXT       Issue body text, or
  --body-file PATH  Read the body from a file; - reads standard input (not both with --body)
  --label LABEL     Repeatable, at most ${MAX_LABELS}; each must already exist (never created).
                    GitHub may drop labels you lack permission to set: reported as partial
  --repo owner/name Target repository (default: the current checkout)
  --agent NAME      Reported agent, recorded as provenance only (never authority)
  --dry-run         Resolve and validate; show target, title, body and labels; no write
  --json            One versioned JSON document on stdout

Arguments are passed to gh as data, never through a shell. The body gets a hidden marker
(${ISSUE_CREATE_MARKER}) with an operation ID, the target ID and a digest of title, body and
labels; it is a correlation receipt, not a claim, approval or signature. No status, claim or
agent label is added. The local checkout configuration and identity are never changed.

Retries: exactly one create request is sent per invocation and none is ever retried
automatically. After a timeout, 5xx or lost reply the outcome is "unknown": inspect the target's
recent issues for the operation ID before running the command again. Two separate invocations
are separate intents and can create duplicates; there is no exactly-once guarantee.

Status: planned (dry-run), created (verified), partial (issue exists, a requested detail such
as a label is missing), unknown (the request may have been committed), refused (nothing created).
Exit: 0 planned/created; 2 partial/unknown; 1 invalid input or refused.
`;

/** One injected create (POST) answer. `dispatched` false proves the request never left. */
export interface PostAnswer {
  dispatched: boolean;
  status: number | null;
  body: unknown;
  evidence?: FailureClassification;
  timedOut?: boolean;
}
export type RestPost = (path: string, payload: unknown) => Promise<PostAnswer>;

export interface IssueCreateRuntime {
  rest: Rest;
  post: RestPost;
  currentRepository: () => Promise<string>;
  now: () => Date;
  operationId: () => string;
  readFile: (path: string) => Promise<Uint8Array>;
  readStdin: () => Promise<Uint8Array>;
  /** Preflight diagnostics (text mode only); never stdout. */
  stderr: (text: string) => void;
}

export interface IssueCreateRequest {
  title: string;
  body?: string;
  bodyFile?: string;
  labels: string[];
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
  error: { id: string; message: string; evidence?: FailureClassification } | null;
  warnings: string[];
  recovery: string[];
  /** Dry-run only: the exact body that would be sent, including the marker. */
  preview?: { body: string; bodyBytes: number };
}

export class IssueCreateUsageError extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const codePoints = (text: string) => Array.from(text).length;

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
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of request.labels) {
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
  return { ...request, labels };
}

/** Read the body: text, a file or stdin, decoded as strict UTF-8 and bounded. */
async function readBody(request: IssueCreateRequest, rt: IssueCreateRuntime): Promise<string> {
  if (request.bodyFile === undefined) return request.body ?? "";
  let bytes: Uint8Array;
  try {
    bytes = request.bodyFile === "-" ? await rt.readStdin() : await rt.readFile(request.bodyFile);
  } catch {
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

/** Digest of the user's intent: exact title, exact user body and requested labels. */
export function intentDigest(title: string, body: string, labels: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([title, body, [...labels].sort()]))
    .digest("hex");
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

const httpsIssueUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;

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

  const read = async (path: string): Promise<RestAnswer | null> => {
    try {
      return await rt.rest(path);
    } catch {
      return null;
    }
  };
  const readRefusal = (answer: RestAnswer | null, what: string) => {
    const evidence = answer?.evidence;
    const category = evidence?.category;
    if (category === "rate-limited" || category === "secondary-rate-limit")
      return refuse(
        "QUOTA",
        `GitHub rate limited the ${what} read; nothing was created. Retry after the reported reset.`,
        evidence,
      );
    if (answer?.status === 401 || category === "authentication")
      return refuse(
        "AUTHENTICATION",
        "GitHub refused the gh login. Run gh auth status, then retry.",
        evidence,
      );
    if (answer?.status === 404 || answer?.status === 403 || category === "access")
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

  const repository = await read(`repos/${requested}`);
  if (repository?.status !== 200 || !isRecord(repository.body))
    return readRefusal(repository, "repository");
  const fullName = prop(repository.body, "full_name");
  const id = prop(repository.body, "id");
  const nodeId = prop(repository.body, "node_id");
  const htmlUrl = prop(repository.body, "html_url");
  if (
    typeof fullName !== "string" ||
    !REPO.test(fullName) ||
    typeof id !== "number" ||
    typeof nodeId !== "string" ||
    !nodeId
  )
    return refuse("TARGET_UNVERIFIED", "GitHub returned no verifiable repository identity.");
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
    url: typeof htmlUrl === "string" ? htmlUrl : `https://github.com/${fullName}`,
  };
  if (prop(repository.body, "archived") === true)
    return refuse("ARCHIVED", `${fullName} is archived; issues cannot be created.`);
  if (prop(repository.body, "has_issues") === false)
    return refuse("ISSUES_DISABLED", `Issues are disabled on ${fullName}.`);

  const user = await read("user");
  const login = user?.status === 200 ? prop(user.body, "login") : null;
  if (typeof login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login))
    return readRefusal(user, "authenticated user");
  result.viewer = login;

  // Labels: each must exist (this command never creates one). Setting labels needs push access;
  // GitHub otherwise drops them, which is disclosed now and verified after creation.
  for (const label of request.labels) {
    const answer = await read(`repos/${fullName}/labels/${encodeURIComponent(label)}`);
    if (answer?.status === 404)
      return refuse(
        "LABEL_MISSING",
        `Label ${JSON.stringify(label)} does not exist on ${fullName}; this command never creates labels.`,
      );
    if (answer?.status !== 200) return readRefusal(answer, "label");
  }
  const push = prop(repository.body, "permissions", "push");
  if (request.labels.length && push !== true)
    result.warnings.push(
      push === false
        ? `${login} lacks push access to ${fullName}; GitHub may create the issue without the requested labels.`
        : `Could not confirm label permission on ${fullName}; labels are verified after creation.`,
    );

  const marker = creationMarker({
    operationId,
    repository: fullName,
    repositoryId: nodeId,
    digest: intentDigest(request.title, userBody, request.labels),
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
    ...(request.labels.length ? { labels: request.labels } : {}),
  };
  let answer: PostAnswer;
  try {
    answer = await rt.post(`repos/${fullName}/issues`, payload);
  } catch {
    answer = { dispatched: true, status: null, body: null };
  }
  const unknown = (message: string) => {
    result.status = "unknown";
    result.error = {
      id: "OUTCOME_UNKNOWN",
      message,
      ...(answer.evidence ? { evidence: answer.evidence } : {}),
    };
    result.recovery = [
      ...recovery,
      `Look for operation ${operationId} in issues ${login} created on ${fullName} since ${startedAt}. Do not re-run unless no issue carries it; a bounded search cannot prove absence.`,
    ];
    return result;
  };
  if (!answer.dispatched)
    return refuse("NOT_DISPATCHED", "The create request was not sent; nothing was created.");
  if (answer.status === null || answer.timedOut || answer.status >= 500)
    return unknown(
      "The create request was sent but no definitive answer arrived (timeout, lost reply or server error); the issue may exist.",
    );
  if (answer.status !== 201) {
    const category = answer.evidence?.category;
    if (category === "rate-limited" || category === "secondary-rate-limit" || answer.status === 429)
      return refuse(
        "QUOTA",
        "GitHub rate limited the create request; nothing was created. Retry after the reported reset.",
        answer.evidence,
      );
    if (answer.status === 401)
      return refuse("AUTHENTICATION", "GitHub refused the gh login.", answer.evidence);
    if (answer.status === 410)
      return refuse("ISSUES_DISABLED", `Issues are disabled on ${fullName}.`, answer.evidence);
    if (answer.status === 403 || answer.status === 404)
      return refuse(
        "PERMISSION",
        `GitHub refused issue creation on ${fullName} for ${login}.`,
        answer.evidence,
      );
    if (answer.status === 422)
      return refuse(
        "REJECTED",
        "GitHub rejected the issue content (validation failed).",
        answer.evidence,
      );
    if (answer.status >= 400)
      return refuse(
        "REJECTED",
        `GitHub refused the request (HTTP ${answer.status}).`,
        answer.evidence,
      );
    return unknown(`GitHub answered HTTP ${answer.status}, which does not prove creation.`);
  }
  // Verify the created issue's identity; never construct a URL from an unverified number.
  const created = answer.body;
  const number = prop(created, "number");
  const issueNode = prop(created, "node_id");
  const issueUrl = prop(created, "html_url");
  const repositoryUrl = prop(created, "repository_url");
  const expectedUrl = `https://github.com/${fullName}/issues/${String(number)}`;
  if (
    !isRecord(created) ||
    "pull_request" in created ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1 ||
    typeof issueNode !== "string" ||
    !issueNode ||
    typeof issueUrl !== "string"
  )
    return unknown("GitHub answered 201 without a verifiable issue identity; the issue may exist.");
  if (
    issueUrl.toLowerCase() !== expectedUrl.toLowerCase() ||
    (typeof repositoryUrl === "string" &&
      !repositoryUrl.toLowerCase().endsWith(`/repos/${fullName.toLowerCase()}`))
  ) {
    if (httpsIssueUrl.test(issueUrl))
      result.warnings.push(`GitHub reported an issue outside the intended target: ${issueUrl}`);
    return unknown(
      "The created issue does not match the intended target; not reported as created.",
    );
  }
  result.issue = { number, nodeId: issueNode, url: issueUrl };
  const names = (value: unknown): string[] | null =>
    Array.isArray(value)
      ? value.flatMap((l) => {
          const name = prop(l, "name");
          return typeof name === "string" ? [name] : [];
        })
      : null;
  let applied = names(prop(created, "labels"));
  const missing = (have: string[] | null) =>
    request.labels.filter((l) => !(have ?? []).some((h) => h.toLowerCase() === l.toLowerCase()));
  if (request.labels.length && missing(applied).length) {
    // One bounded read-back before reporting labels missing.
    const back = await read(`repos/${fullName}/issues/${number}`);
    if (back?.status === 200 && prop(back.body, "node_id") === issueNode)
      applied = names(prop(back.body, "labels"));
    else result.warnings.push("Read-back of the created issue failed; label state is unverified.");
  }
  result.labels.applied = applied ?? [];
  const absent = missing(applied);
  if (absent.length) {
    result.status = "partial";
    result.error = {
      id: "LABELS_MISSING",
      message: `Issue created, but GitHub did not apply: ${absent.join(", ")}. Do not create it again.`,
    };
    result.recovery = absent.map((l) =>
      ["gh", "issue", "edit", String(number), "--repo", fullName, "--add-label", l]
        .map(shellQuote)
        .join(" "),
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
  if (result.issue) lines.push(`Issue: #${result.issue.number} ${result.issue.url}`);
  if (result.preview) lines.push(`Body (${result.preview.bodyBytes} bytes):`, result.preview.body);
  if (result.error) lines.push(`${result.error.id}: ${result.error.message}`);
  for (const w of result.warnings) lines.push(`Warning: ${w}`);
  for (const r of result.recovery) lines.push(`Recovery: ${r}`);
  return lines.join("\n") + "\n";
}

/**
 * Production create boundary: `gh api --include -X POST PATH --input -` with the JSON payload on
 * stdin, no shell. A spawn failure proves no dispatch; anything after is treated as dispatched.
 */
type Spawn = typeof spawn;
/**
 * Production create boundary over an injectable spawn (tests pass a fake child). A stdin error
 * (EPIPE when gh exits before reading) never crashes: the close handler decides the outcome,
 * which without a 201 response is never "created".
 */
export const ghPostWith =
  (spawnChild: Spawn = spawn): RestPost =>
  (path, payload) =>
    new Promise<PostAnswer>((resolve) => {
      let child;
      try {
        child = spawnChild("gh", ["api", "--include", "--method", "POST", path, "--input", "-"], {
          stdio: ["pipe", "pipe", "ignore"],
          shell: false,
        });
      } catch {
        resolve({ dispatched: false, status: null, body: null });
        return;
      }
      let spawned = false;
      let timedOut = false;
      let stdout = "";
      child.stdin.on("error", () => {
        // EPIPE/ECONNRESET: gh exited without reading; the exit decides refused vs unknown.
      });
      child.once("spawn", () => {
        spawned = true;
        child.stdin.end(JSON.stringify(payload));
      });
      child.stdout.setEncoding("utf8").on("data", (t: string) => (stdout += t));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 60_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ dispatched: spawned, status: null, body: null });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ dispatched: true, status: null, body: null, timedOut: true });
          return;
        }
        try {
          const response = parseGhResponse(stdout);
          let body: unknown = null;
          try {
            body = JSON.parse(response.body);
          } catch {
            body = null;
          }
          const status = response.status;
          resolve({
            dispatched: true,
            status,
            body,
            ...(status !== 201
              ? { evidence: classifyGhFailure({ response, exitCode: code }) }
              : {}),
          });
        } catch {
          resolve({ dispatched: true, status: null, body: null });
        }
      });
    });

export const ghPost: RestPost = ghPostWith();

/** Bounded stdin read: stops accumulating just past the body limit. */
export async function readStdinBounded(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) break;
  }
  return Buffer.concat(chunks);
}

export const defaultReadFile = async (path: string): Promise<Uint8Array> => readFile(path);
