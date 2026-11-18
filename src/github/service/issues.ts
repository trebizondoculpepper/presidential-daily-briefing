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

const REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

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
}

export type RestPost = (path: string, payload: unknown) => Promise<PostAnswer>;

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
  ): Promise<PostAnswer>;
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

    create(repository, payload) {
      return post(`repos/${repository}/issues`, payload);
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
