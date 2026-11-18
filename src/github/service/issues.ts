/**
 * Typed issue creation and read-back capabilities (#887, doc/design/github-service-composition.md).
 *
 * Encapsulates the one-attempt `gh api --method POST repos/{owner}/{repo}/issues --input -`
 * dispatch (`ghPostWith`) and validated REST reads for repository metadata, viewer login, label
 * existence, and created-issue read-back.
 */
import { spawn } from "node:child_process";
import { classifyGhFailure, parseGhResponse } from "../evidence.js";
import type { FailureClassification } from "../evidence.js";
import { isRecord, prop } from "../github.js";
import type { Rest, RestAnswer } from "../github.js";
import type { GhTransport } from "./transport.js";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const HTTPS_ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;

export interface IssueCreatePayload {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

/** One create (POST) answer. `dispatched` false proves the request never left. */
export interface PostAnswer {
  dispatched: boolean;
  status: number | null;
  body: unknown;
  evidence?: FailureClassification;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type RestPost = (
  path: string,
  payload: unknown,
  options?: { signal?: AbortSignal },
) => Promise<PostAnswer>;

export interface CreatedIssueRecord {
  number: number;
  nodeId: string;
  url: string;
  labels: string[] | null;
  assignees: string[] | null;
}

export type IssueCreateOutcome =
  | { kind: "created"; issue: CreatedIssueRecord }
  | { kind: "not-dispatched"; cancelled?: boolean }
  | { kind: "refused"; status: number; evidence?: FailureClassification }
  | {
      kind: "unknown";
      reason: "transport" | "unexpected-status" | "malformed" | "target-mismatch";
      status: number | null;
      mismatchedUrl?: string;
      evidence?: FailureClassification;
    };

export interface IssueRepositoryMeta {
  fullName: string;
  id: number;
  nodeId: string;
  url: string;
  archived: boolean;
  hasIssues: boolean;
  pushPermission: boolean | null;
}

export type IssueReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null; evidence?: FailureClassification; unverified?: boolean };

export interface IssueCapabilities {
  /** Read and validate repository metadata for issue creation (`GET /repos/{owner}/{repo}`). */
  readRepository(
    repository: string,
    signal?: AbortSignal,
  ): Promise<IssueReadResult<IssueRepositoryMeta>>;
  /** Read authenticated viewer login (`GET /user`) with normalized failure evidence. */
  readViewer(signal?: AbortSignal): Promise<IssueReadResult<string>>;
  /** Check whether a label exists (`GET /repos/{owner}/{repo}/labels/{name}`). */
  hasLabel(
    repository: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<IssueReadResult<boolean>>;
  /** One-attempt issue create (`POST /repos/{owner}/{repo}/issues`); never retried. */
  create(
    repository: string,
    payload: IssueCreatePayload,
    signal?: AbortSignal,
  ): Promise<IssueCreateOutcome>;
  /** Bounded read-back of a created issue (`GET /repos/{owner}/{repo}/issues/{number}`). */
  readBack(
    repository: string,
    number: number,
    expectedNodeId: string,
    signal?: AbortSignal,
  ): Promise<{ labels: string[] | null; assignees: string[] | null } | null>;
}

type Spawn = typeof spawn;

/**
 * Production create boundary over an injectable spawn (tests pass a fake child). A stdin error
 * (EPIPE when gh exits before reading) never crashes: the close handler decides the outcome,
 * which without a 201 response is never "created".
 */
export const ghPostWith =
  (spawnChild: Spawn = spawn, env?: NodeJS.ProcessEnv): RestPost =>
  (path, payload) =>
    new Promise<PostAnswer>((resolve) => {
      let child;
      try {
        child = spawnChild("gh", ["api", "--include", "--method", "POST", path, "--input", "-"], {
          stdio: ["pipe", "pipe", "ignore"],
          shell: false,
          ...(env ? { env } : {}),
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

/** One-attempt POST over the shared GH transport; honours cancellation before dispatch. */
export const postOverTransport =
  (transport: GhTransport, env?: NodeJS.ProcessEnv): RestPost =>
  async (path, payload, options) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      return { dispatched: false, status: null, body: null, cancelled: true };
    }
    const outcome = await transport({
      args: ["api", "--include", "--method", "POST", path, "--input", "-"],
      ...(env ? { env } : {}),
      stdin: JSON.stringify(payload),
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
      signal,
    });
    if (!outcome.ok) {
      if (outcome.kind === "spawn") return { dispatched: false, status: null, body: null };
      if (outcome.kind === "timeout")
        return { dispatched: true, status: null, body: null, timedOut: true };
      if (outcome.kind === "cancelled")
        return { dispatched: true, status: null, body: null, cancelled: true };
    }
    try {
      const response = parseGhResponse(outcome.stdout);
      let body: unknown = null;
      try {
        body = JSON.parse(response.body);
      } catch {
        body = null;
      }
      const status = response.status;
      return {
        dispatched: true,
        status,
        body,
        ...(status !== 201
          ? {
              evidence: classifyGhFailure({
                response,
                exitCode: outcome.ok ? 0 : outcome.exitCode,
              }),
            }
          : {}),
      };
    } catch {
      return { dispatched: true, status: null, body: null };
    }
  };

const fieldStrings = (value: unknown, key: string): string[] | null =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = prop(entry, key);
        return typeof item === "string" ? [item] : [];
      })
    : null;

/** Build typed issue capabilities over a REST reader and one-attempt POST boundary. */
export function issueCapabilities(rest: Rest, post: RestPost): IssueCapabilities {
  const safeRead = async (path: string, signal?: AbortSignal): Promise<RestAnswer | null> => {
    try {
      return await rest(path, { signal });
    } catch {
      return null;
    }
  };
  return {
    async readRepository(repository, signal) {
      const answer = await safeRead(`repos/${repository}`, signal);
      if (answer?.status !== 200 || !isRecord(answer.body)) {
        return {
          ok: false,
          status: answer?.status ?? null,
          ...(answer?.evidence ? { evidence: answer.evidence } : {}),
        };
      }
      const fullName = prop(answer.body, "full_name");
      const id = prop(answer.body, "id");
      const nodeId = prop(answer.body, "node_id");
      const htmlUrl = prop(answer.body, "html_url");
      if (
        typeof fullName !== "string" ||
        !REPO.test(fullName) ||
        typeof id !== "number" ||
        typeof nodeId !== "string" ||
        !nodeId
      ) {
        return { ok: false, status: 200, unverified: true };
      }
      const push = prop(answer.body, "permissions", "push");
      return {
        ok: true,
        value: {
          fullName,
          id,
          nodeId,
          url: typeof htmlUrl === "string" ? htmlUrl : `https://github.com/${fullName}`,
          archived: prop(answer.body, "archived") === true,
          hasIssues: prop(answer.body, "has_issues") === false ? false : true,
          pushPermission: typeof push === "boolean" ? push : null,
        },
      };
    },

    async readViewer(signal) {
      const answer = await safeRead("user", signal);
      const login = answer?.status === 200 ? prop(answer.body, "login") : null;
      if (typeof login !== "string" || !GITHUB_LOGIN.test(login)) {
        return {
          ok: false,
          status: answer?.status ?? null,
          ...(answer?.evidence ? { evidence: answer.evidence } : {}),
        };
      }
      return { ok: true, value: login };
    },

    async hasLabel(repository, label, signal) {
      const answer = await safeRead(
        `repos/${repository}/labels/${encodeURIComponent(label)}`,
        signal,
      );
      if (answer?.status === 404) return { ok: true, value: false };
      if (answer?.status === 200) return { ok: true, value: true };
      return {
        ok: false,
        status: answer?.status ?? null,
        ...(answer?.evidence ? { evidence: answer.evidence } : {}),
      };
    },

    async create(repository, payload, signal) {
      const answer = await post(`repos/${repository}/issues`, payload, { signal });
      if (!answer.dispatched) {
        return { kind: "not-dispatched", ...(answer.cancelled ? { cancelled: true } : {}) };
      }
      if (answer.status === null || answer.timedOut || answer.status >= 500) {
        return {
          kind: "unknown",
          reason: "transport",
          status: answer.status,
          ...(answer.evidence ? { evidence: answer.evidence } : {}),
        };
      }
      if (answer.status !== 201) {
        if (answer.status >= 400) {
          return {
            kind: "refused",
            status: answer.status,
            ...(answer.evidence ? { evidence: answer.evidence } : {}),
          };
        }
        return {
          kind: "unknown",
          reason: "unexpected-status",
          status: answer.status,
          ...(answer.evidence ? { evidence: answer.evidence } : {}),
        };
      }
      const created = answer.body;
      const number = prop(created, "number");
      const issueNode = prop(created, "node_id");
      const issueUrl = prop(created, "html_url");
      const repositoryUrl = prop(created, "repository_url");
      const expectedUrl = `https://github.com/${repository}/issues/${String(number)}`;
      if (
        !isRecord(created) ||
        "pull_request" in created ||
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1 ||
        typeof issueNode !== "string" ||
        !issueNode ||
        typeof issueUrl !== "string"
      ) {
        return { kind: "unknown", reason: "malformed", status: 201 };
      }
      if (
        issueUrl.toLowerCase() !== expectedUrl.toLowerCase() ||
        (typeof repositoryUrl === "string" &&
          !repositoryUrl.toLowerCase().endsWith(`/repos/${repository.toLowerCase()}`))
      ) {
        return {
          kind: "unknown",
          reason: "target-mismatch",
          status: 201,
          ...(HTTPS_ISSUE_URL.test(issueUrl) ? { mismatchedUrl: issueUrl } : {}),
        };
      }
      return {
        kind: "created",
        issue: {
          number,
          nodeId: issueNode,
          url: issueUrl,
          labels: fieldStrings(prop(created, "labels"), "name"),
          assignees: fieldStrings(prop(created, "assignees"), "login"),
        },
      };
    },

    async readBack(repository, number, expectedNodeId, signal) {
      const back = await safeRead(`repos/${repository}/issues/${number}`, signal);
      if (back?.status !== 200 || prop(back.body, "node_id") !== expectedNodeId) return null;
      return {
        labels: fieldStrings(prop(back.body, "labels"), "name"),
        assignees: fieldStrings(prop(back.body, "assignees"), "login"),
      };
    },
  };
}
