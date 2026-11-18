import type { LocalDoctorRuntime } from "../config/localdoctor.js";
import type { EffectiveHuman, EffectiveIdentityRuntime } from "../config/effectiveidentity.js";
import type { LocalIdentitySession } from "../config/serveridentity.js";
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
import type { GitService } from "../git/service.js";
import type { GlobalConfigFileSystem } from "../config/globalconfig.js";
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
  /** Monotonic engine-budget clock; independent of the evidence wall clock. */
  engineClock?: ReadRuntime["engineClock"];
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

/** The verified per-user configuration boundary `serve` resolves and records projects in (#805). */
export interface GlobalConfigBoundary {
  /** The per-OS-user directory holding `config.toml` (doc/design/configuration-service.md). */
  readonly dir: string;
  readonly fs?: GlobalConfigFileSystem;
}

/** Injected boundaries of `pdb serve`. */
export interface ServeRuntime {
  /** Trusted local startup preparation; tests inject disposable boundaries. */
  identityRuntime?: Omit<EffectiveIdentityRuntime, "human">;
  /** Invoking working directory for resolving relative `--project` paths (#569). */
  cwd?: string;
  /**
   * Git boundary for resolving nested `--project` paths and worktrees to their root (#569): the
   * composition's shared typed service, or a legacy runner as its transport (#870).
   */
  git?: GitService | GitRunner;
  /**
   * Verified global configuration boundary (#805). When present, `serve` resolves saved
   * registrations and the working directory's repository, and records new ones; when absent it
   * serves only the explicit targets.
   */
  globalConfig?: GlobalConfigBoundary;
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
  /** Optional trusted process metadata, captured once; absent fields remain unknown. */
  buildIdentity?: () => Promise<Partial<BuildIdentity>>;
  platform: NodeJS.Platform;
  /** GitHub read boundaries for the data routes; absent means the production gh runners. */
  read?: ServeReadRuntime;
  /** Local read-only git/file boundaries of the rules page (#392); absent means the real ones. */
  rulesPage?: RulesPageRuntime;
  /** Read-only Doctor probes; run scope/root and cancellation are fixed by the server. */
  doctor?: LocalDoctorRuntime;
}

/** One repository of the served set, with the checkout that configures it, if any. */
export interface ServedRepository {
  repository: string;
  project?: string;
}

/** Provenance of the executing build, never the selected repository or current disk checkout. */
export interface BuildIdentity {
  revision: string | null;
  dirty: boolean | null;
  publicIp: string | null;
  source: "package-githead" | "build-metadata" | "unknown";
}
export interface ProcessIdentity extends BuildIdentity {
  version: string | null;
  startedAt: string | null;
}

/** Facts fixed at startup, shown by /api/v1/status. */
export interface ServerFacts {
  /** Process-local startup identity and the last actual gh-auth observation. */
  identitySession?: LocalIdentitySession;
  effectiveHuman?: EffectiveHuman;
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
