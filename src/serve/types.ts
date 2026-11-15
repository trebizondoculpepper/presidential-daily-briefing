/**
 * Shared `pdb serve` interfaces (#445). They live here, apart from the `serve.ts` entry module,
 * so `serve/*` modules can share them without importing `serve.ts`: this module imports no
 * `serve` module except the self-contained rules page's runtime type, which breaks the former
 * `serve` / `serve/api` / `serve/cache` / `serve/mcp` / `serve/services` import cycle.
 * `serve.ts` and `serve/api.ts` re-export these names, so existing importers are unchanged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadRuntime } from "../briefing/service.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import type { Environment } from "../config/harness.js";
import type { dependencyReport as DependencyReportFn } from "../github/dependencies.js";
import type {
  collect as Collect,
  collectIssueFocus as CollectIssueFocus,
  Query,
  Rest,
} from "../github/github.js";
import type { Clock } from "../mcp/polling.js";
import type { RulesPageRuntime } from "./rules-page.js";

/** The gh account every collection runs as: host and login only, never a token. */
export interface AuthContext {
  host: string;
  login: string;
}

/** Process signals the server listens to; tests pass an EventEmitter. */
export interface SignalSource {
  on(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
}

/** GitHub read boundaries for the data routes. */
export interface ServeReadRuntime {
  collect: typeof Collect;
  /** Shared routine discovery/hydration plan (#368/#453). */
  collectShortlist?: ReadRuntime["collectShortlist"];
  /** Test seam for the lazily loaded Datalog engine (#346). */
  loadEngine?: ReadRuntime["loadEngine"];
  /** Focused `who` read (issue-detail-v1, #367); default: the gh collector over queryWith. */
  collectIssueFocus?: typeof CollectIssueFocus;
  dependencyReport: typeof DependencyReportFn;
  rest?: Rest;
  queryWith?: (signal?: AbortSignal) => Query;
  now: () => Date;
  env: Environment;
  git?: GitRunner;
  fs?: ConfigFileSystem;
  /** Local configuration readers rooted at a project (estimation and guide settings). */
  projectRuntime?: (project: string | undefined) => Pick<ReadRuntime, "estimation" | "guide">;
}

/** Injected boundaries of `pdb serve`. */
export interface ServeRuntime {
  /** Resolve a local checkout to its owner/name (startup only). */
  currentRepository: (cwd?: string, signal?: AbortSignal) => Promise<string>;
  /** The gh host and login (startup, and before live collections at most once per TTL). */
  authContext: (signal?: AbortSignal) => Promise<AuthContext>;
  clock: Clock;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signals: SignalSource;
  /** Immediate exit for a second signal during shutdown. */
  exit: (code: number) => void;
  version: () => Promise<string | null>;
  platform: NodeJS.Platform;
  /** GitHub read boundaries for the data routes; absent means the production gh runners. */
  read?: ServeReadRuntime;
  /** Local read-only git/file boundaries of the rules page (#392); absent means the real ones. */
  rulesPage?: RulesPageRuntime;
}

/** One repository of the served set, with the checkout that configures it, if any. */
export interface ServedRepository {
  repository: string;
  project?: string;
}

/** Facts fixed at startup, shown by /api/v1/status. */
export interface ServerFacts {
  version: string | null;
  startedAt: Date;
  url: string;
  exposed: boolean;
  served: ServedRepository[];
  ttlMs: number;
  auth: AuthContext;
}

/** Per-request context handed to routes. */
export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Aborted when the client disconnects or the server shuts down. */
  signal: AbortSignal;
  /** Set by a data route to the cache source it served ("live", "cached", "stale"). */
  source?: string;
}

/** A route set; returns false when it does not own the path. */
export type Routes = (context: RequestContext) => Promise<boolean>;

/** Cache counters for status; the read API (PR 2 of #373) supplies the real cache. */
export interface StatusSource {
  cache(): Record<string, number>;
  repositories(): Record<string, { observedAt: string | null; lastError: unknown }>;
  /** Additive capability metadata: the read-only diagnostic URLs installed (#459). */
  diagnostics?(): string[];
}

/** Services built once the server is listening: data routes, MCP and status counters. */
export interface ServeServices {
  routes?: Routes;
  status?: StatusSource;
  /** Close long-lived resources (in-flight collections, MCP sessions) during shutdown. */
  close?: () => Promise<void>;
}

/** Builds the services from the startup facts (bound URL, served set, auth context). */
export type ServeExtensions = (facts: ServerFacts) => ServeServices;

/** A listening server. */
export interface RunningServer {
  facts: ServerFacts;
  port: number;
  /** Graceful shutdown; resolves once every connection is closed. Idempotent. */
  close(): Promise<void>;
  /** Resolves when shutdown completes. */
  closed: Promise<void>;
  shuttingDown(): boolean;
}
