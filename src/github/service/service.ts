/**
 * The typed GH service (#869, doc/design/github-service-composition.md): application callers
 * use named capabilities with validated results instead of gh argument arrays or raw JSON.
 * Built by a factory over the injectable transport; no process-global repository, account or
 * agent. Initial capabilities: the authenticated account and the repository of a checkout. The
 * remaining capability groups arrive with their migration tickets (#878-#891).
 */

import {
  collect,
  collectIssueFocus,
  ghQueryFailure,
  ghQueryWith,
  hydratePullRequests,
  locateIssue,
  graphqlApiOverTransport,
  permissionLookup,
  restOverTransport,
} from "../github.js";
import type {
  CollectOptions,
  FocusOptions,
  IssueDiagnosis,
  PermissionLookup,
  Rest,
} from "../github.js";
import type { PullRequest, Snapshot } from "../types.js";
import { collectShortlist, type ShortlistOptions } from "../shortlist.js";
import { execFileTransport } from "./transport.js";
import type { GhTransport } from "./transport.js";
import { repositoryFromCheckout, throwIfCancelled } from "./repository.js";
import { historyReads } from "./history.js";
import { checkReads } from "./checks.js";
import { readRateLimits } from "./ratelimits.js";
import { resolveLabels } from "./labels.js";
import { ticketReads } from "./tickets.js";
import { closingReferencesPage } from "./references.js";
import type { ClosingReferencesPage } from "./references.js";
import type { TicketReads } from "./tickets.js";
import { deliveryIssue } from "./delivery.js";
import type { DeliveryIssue } from "./delivery.js";
import { estimationCapabilities, type EstimationCapabilities } from "./estimation.js";
import { commentPostOver, ghCommentReceipt } from "../dependencies.js";
import { withCommentRecovery } from "../commentwrite.js";
import type {
  CommentCallOptions,
  CommentRecovery,
  CommentRecoveryPolicy,
} from "../commentwrite.js";
import type { LabelResolution } from "./labels.js";
import { issueCapabilities, postOverTransport } from "./issues.js";
import type { IssueCapabilities, RestPost } from "./issues.js";
import { closedQuestionsCapabilities } from "./closedquestions.js";
import type { ClosedQuestionCapabilities } from "./closedquestions.js";
import { discoveryPage, issueCommentsPage, issuesByNumber } from "./snapshot.js";
import type { Issue } from "./snapshot.js";
import type { Query } from "../github.js";
import type { RateLimitAnswer } from "./ratelimits.js";
import type { CheckReads } from "./checks.js";
import type { HistoryReads } from "./history.js";
import { completionCapabilities, runOverTransport } from "./completion.js";
import type { CompletionCapabilities } from "./completion.js";
import type { GhRun, GraphQuery } from "../../workflow/claims.js";

export interface GhAccount {
  host: string;
  login: string;
}

export interface GhService {
  account: {
    /** The authenticated gh account (host and login only, never a token): `GET /user`. */
    current(signal?: AbortSignal): Promise<GhAccount>;
    /**
     * The account's rate-limit buckets: `GET /rate_limit` with this response's status and
     * failure evidence, normalised (#547, #923). A thrown read (abort, deadline) propagates.
     */
    rateLimits(signal?: AbortSignal): Promise<RateLimitAnswer>;
  };
  repos: {
    /**
     * The `owner/name` gh resolves for a checkout. A local step (gh reads the checkout's remotes
     * and its own configuration) followed by a repository lookup, not a single API call.
     */
    fromCheckout(cwd?: string, signal?: AbortSignal): Promise<string>;
    /**
     * A cached lookup of a login's permission on the repository:
     * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Unknown, never guessed.
     */
    permissionOf(repository: string, signal?: AbortSignal): PermissionLookup;
  };
  /** Validated ticket-history reads for bounded history consumers (#931). */
  history: HistoryReads;
  /** Required-check evidence: branch rules and protection, head requiredness (#926). */
  checks: CheckReads;
  /** Comment writes with the shared bounded recovery (#918, doc/design/comment-write-recovery.md). */
  comments: {
    /**
     * Post one frozen comment: at most one guarded retry after a throttle, a receipt read-back
     * by this write's own nonce, and never a blind re-POST. Resolves with the recovery record
     * when posted; rejects with CommentWriteError otherwise (may-have-posted included).
     */
    create(
      target: { repository: string; number: number; body: string },
      call?: CommentCallOptions,
    ): Promise<CommentRecovery>;
  };
  /** Delivery-view issue reads (#945). */
  delivery: {
    /** One issue's state, closing PRs and validated newest comments; null only when absent. */
    issue(repository: string, number: number): Promise<DeliveryIssue | null>;
  };
  /** Claim-workflow guard and pull-request state reads (#942). */
  tickets: TicketReads;
  /** Issue reference reads (#951). */
  references: {
    /** One validated page of an issue's closing references, closed pull requests included. */
    closingPage(
      repository: string,
      number: number,
      perPage: number,
      cursor: string | null,
    ): Promise<ClosingReferencesPage>;
  };
  /** Repository label resolution (#921). */
  labels: {
    /** Resolve normalized names to canonical labels; unresolved on any failed or partial read. */
    resolve(repository: string, names: readonly string[]): Promise<LabelResolution>;
  };
  /** Issue creation, locate, and bounded read-back capabilities (#887, #920). */
  issues: IssueCapabilities & {
    locate(repository: string, number: number, signal?: AbortSignal): Promise<IssueDiagnosis>;
  };
  /** Closed-question discovery and comment pagination (#899). */
  closedQuestions: ClosedQuestionCapabilities;
  /** Open-work snapshot reads behind the shortlist briefing (#927). */
  snapshot: {
    discoveryPage(
      repository: string,
      field: "issues" | "pullRequests",
      fields: string,
      pageSize: number,
      cursor: string | null,
      signal?: AbortSignal,
    ): Promise<unknown>;
    issuesByNumber(
      repository: string,
      numbers: readonly number[],
      fields: string,
      signal?: AbortSignal,
    ): Promise<(Issue | null)[]>;
    issueCommentsPage(
      repository: string,
      number: number,
      commentFields: string,
      cursor: string,
      signal?: AbortSignal,
    ): Promise<unknown>;
    collect(repository: string, options?: CollectOptions, now?: () => Date): Promise<Snapshot>;
    collectShortlist(
      repository: string,
      options: ShortlistOptions,
      now?: () => Date,
    ): Promise<Snapshot>;
    collectIssueFocus(
      repository: string,
      number: number,
      options: FocusOptions,
      now?: () => Date,
    ): Promise<Snapshot>;
    hydratePullRequests(
      repository: string,
      targets: readonly { number: number; url: string }[],
      options: Parameters<typeof hydratePullRequests>[2],
    ): Promise<PullRequest[]>;
  };
  completion: CompletionCapabilities;
  /** Typed estimation reads and guarded label/comment mutations (#916). */
  estimation: EstimationCapabilities;
}

export interface GhServiceOptions {
  transport?: GhTransport;
  /** The environment gh itself reads (GH_HOST selects the host); injected for isolation. */
  env?: NodeJS.ProcessEnv;
  /** The REST reader behind REST capabilities; by default one over this service's transport and env. */
  rest?: Rest;
  /** One-attempt POST boundary for issue creation; by default gh --input - over env. */
  post?: RestPost;
  /** The GraphQL executor behind query capabilities; by default one over this transport and env. */
  query?: GraphQuery;
  /** Guarded `gh` write runner behind completion step execution; defaults to `ghRun` (or transport). */
  run?: GhRun;
  /** Clock for observation times. */
  now?: () => Date;
  /** Comment recovery overrides (policy, sleep, clock, nonce, cancellation); production defaults. */
  commentRecovery?: {
    policy?: Partial<CommentRecoveryPolicy>;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
    nonce?: () => string;
    signal?: AbortSignal;
  };
}

const LOGIN = /^[\w.-]+$/;

export function createGhService(options: GhServiceOptions = {}): GhService {
  const transport = options.transport ?? execFileTransport;
  const env = options.env ?? process.env;
  // The default REST reader runs over this service's own transport and environment, so every
  // capability honours the same execution context (host, account, injected transport).
  const rest = options.rest ?? restOverTransport(transport, env);
  const post = options.post ?? postOverTransport(transport, env);
  const query: GraphQuery = options.query ?? ghQueryWith(undefined, {}, { transport, env });
  const run: GhRun = options.run ?? runOverTransport(transport, query as Query, env);
  const queryForSignal = (signal?: AbortSignal): GraphQuery =>
    options.query
      ? (q, vars) => {
          signal?.throwIfAborted();
          return options.query!(q, vars);
        }
      : ghQueryWith(signal, {}, { transport, env });
  return {
    account: {
      async current(signal) {
        const outcome = await transport({
          args: ["api", "user"],
          // gh runs with the same environment that names the host below, so the account
          // queried and the host reported can never disagree.
          env,
          timeoutMs: 30_000,
          maxBufferBytes: 1024 * 1024,
          signal,
        });
        throwIfCancelled(outcome, signal);
        if (!outcome.ok)
          // Typed as before: authentication, rate limit, or a generic failure. The existing
          // classifier reads the same code/stdout/stderr an execFile error carried.
          throw ghQueryFailure({
            code: outcome.exitCode,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
          });
        let login: unknown;
        try {
          login = (JSON.parse(outcome.stdout) as { login?: unknown }).login;
        } catch {
          throw new Error("gh api user returned an unreadable response.");
        }
        if (typeof login !== "string" || !LOGIN.test(login))
          throw new Error("gh api user returned no login.");
        // GH_HOST selects the host gh talks to; without it gh uses github.com.
        const host = env.GH_HOST?.trim() || "github.com";
        return { host, login };
      },
      rateLimits(signal) {
        return readRateLimits(
          rest,
          () => (options.now ?? (() => new Date()))().toISOString(),
          signal,
        );
      },
    },
    repos: {
      fromCheckout(cwd, signal) {
        return repositoryFromCheckout(transport, cwd, signal, env);
      },
      permissionOf(repository, signal) {
        return permissionLookup(repository, rest, signal);
      },
    },
    history: historyReads(query),
    tickets: ticketReads(query),
    references: {
      closingPage: (repository, number, perPage, cursor) =>
        closingReferencesPage(query as Query, repository, number, perPage, cursor),
    },
    estimation: estimationCapabilities(graphqlApiOverTransport(transport, env)),
    delivery: {
      issue: (repository, number) => deliveryIssue(query as Query, repository, number),
    },
    comments: {
      async create(target, call) {
        // The write and its receipt read run over this service's own transport, environment and
        // query executor; the gh command is an internal detail of the capability.
        const overrides = options.commentRecovery ?? {};
        const run = withCommentRecovery({
          ...overrides,
          // At most one retry (two attempts): an override may lower the limit, never raise it.
          policy: {
            ...overrides.policy,
            maxAttempts: Math.min(overrides.policy?.maxAttempts ?? 2, 2),
          },
          // The service owns its write path: these always win over any override object.
          dispatch: commentPostOver(transport, env),
          readBack: (t, since) => ghCommentReceipt(t, since, query as Query),
        });
        const result = await run(
          [
            "issue",
            "comment",
            String(target.number),
            "--repo",
            target.repository,
            "--body",
            target.body,
          ],
          call,
        );
        return result!;
      },
    },
    labels: {
      resolve: (repository, names) => resolveLabels(repository, names, query as Query),
    },
    issues: {
      ...issueCapabilities(rest, post),
      locate: (repository, number, signal) => locateIssue(repository, number, rest, signal),
    },
    snapshot: {
      discoveryPage: (...args) => discoveryPage(query as Query, ...args),
      issuesByNumber: (...args) => issuesByNumber(query as Query, ...args),
      issueCommentsPage: (...args) => issueCommentsPage(query as Query, ...args),
      collect: (repository, collectOptions = {}, now) =>
        collect(
          repository,
          {
            rest,
            locate: (repo, num) => locateIssue(repo, num, rest, collectOptions.signal),
            ...collectOptions,
          },
          queryForSignal(collectOptions.signal) as Query,
          now ?? options.now,
        ),
      collectShortlist: (repository, shortlistOptions, now) =>
        collectShortlist(
          repository,
          { rest, ...shortlistOptions },
          queryForSignal(shortlistOptions.signal) as Query,
          now ?? options.now,
        ),
      collectIssueFocus: (repository, number, focusOptions, now) =>
        collectIssueFocus(
          repository,
          number,
          {
            rest,
            locate: (repo, num) => locateIssue(repo, num, rest, focusOptions.signal),
            ...focusOptions,
          },
          queryForSignal(focusOptions.signal) as Query,
          now ?? options.now,
        ),
      hydratePullRequests: (repository, targets, hydrateOptions) =>
        hydratePullRequests(
          repository,
          targets,
          hydrateOptions,
          queryForSignal(hydrateOptions.signal) as Query,
        ),
    },
    checks: checkReads(async (q, vars) => {
      const data = await query(q, vars);
      return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    }, rest),
    completion: completionCapabilities(query, rest, run),
    closedQuestions: closedQuestionsCapabilities(query as Query, rest),
  };
}

/** The process's default service over the production transport and environment. */
export const ghService: GhService = createGhService();
