import { BriefingEngineError } from "../config/engine-setting.js";
import { BriefingArgumentError, LabelFilterUnresolved } from "../briefing/compact.js";
import { normalizeLabelRequest } from "../github/labels.js";
/**
 * Read-only MCP adapter (doc/design/mcp.md, #25): the server factory and its tools over the
 * shared read service; no mutation, shell, file-path, cache or checkpoint routes are
 * registered. Served over stdio by src/mcp.ts and over HTTP by `pdb serve` (src/serve/mcp.ts).
 */
import { localPaths, redactLocalText, redactPaths } from "./redact.js";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { collect, currentRepository, ghQueryWith, ghRest } from "../github/github.js";
import { dependencyReport } from "../github/dependencies.js";
import { impactGuidanceSummary } from "../estimation/impact.js";
import { readBriefing, readDependencies } from "../briefing/service.js";
import { catchUp, catchUpLimits } from "../briefing/catchup.js";
import { collectBriefing, WindowRefusal } from "../briefing/catchupcli.js";
import { parseDuration } from "../github/changes.js";
import {
  eventsReport,
  eventsText,
  maxPollIntervalMinutes,
  pollingDefaults,
  sharedCollect,
  systemClock,
  Watcher,
} from "./polling.js";
import type { Clock } from "./polling.js";
import type { ReadRuntime } from "../briefing/service.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { validateHarness } from "../config/harness.js";
import type { Environment } from "../config/harness.js";
import { validateEntryKey } from "../config/identity.js";
import { resolveReadIdentity } from "../config/readidentity.js";
import type { ReadIdentity } from "../config/readidentity.js";
import {
  boundedEnvelope,
  boundedError,
  boundedResult,
  fieldLimit,
  truncationMarker,
  budgetBytes,
  budgetErrorCode,
  resultBytes,
  selectionSchema,
} from "./bounded.js";
import type { BoundedView, ToolResult } from "./bounded.js";
import {
  briefingView,
  dependenciesView,
  issueSections,
  issueView,
  repositoryBriefingView,
  unavailableIssueView,
} from "./views.js";
import type { ViewBase } from "./views.js";
import { pickupOrders } from "../briefing/ranking.js";
import { briefingRoleNames, roleSectionIds } from "../briefing/roles.js";

/** Startup selection. Client roots remain a separately tested follow-up (#25). */
export interface McpOptions {
  /** Configured local project used for repository resolution and repository configuration. */
  project?: string;
  repo?: string;
  agent?: string;
  /** Explicit `[agents.KEY]` entry of the project's pdb.toml (legacy agent-inbox.toml fallback; read only). */
  entry?: string;
  /** Explicit supported harness selecting its entry (read only). */
  harness?: string;
  /** Opt-in proactive polling of the one resolved repository (doc/design/polling-events.md). */
  poll?: boolean;
  /** Minutes between completed polls; default 30, minimum 1. */
  pollIntervalMinutes?: number;
}

/** Injected boundaries; tests replace every GitHub-facing one. */
export interface McpRuntime extends ReadRuntime {
  currentRepository: (cwd?: string, signal?: AbortSignal) => Promise<string>;
  /** Environment for harness detection; absent means no environment signals. */
  env?: Environment;
  /** Git and filesystem boundaries for the read-only identity lookup. */
  git?: GitRunner;
  fs?: ConfigFileSystem;
  /** The process's watcher when polling is enabled; absent means polling is disabled. */
  watcher?: Watcher;
  /**
   * `pdb serve` (doc/design/serve.md "HTTP MCP"): choose the repository of one call from the
   * served set, with its local project and project-rooted readers. Throws
   * {@link SelectionRefusal}. Absent (stdio) means the startup --repo/--project rules.
   */
  served?: (repo: string | undefined) => {
    repository: string;
    project?: string;
    runtime?: Partial<ReadRuntime>;
  };
  /**
   * `pdb serve`: run one call's read and report the freshness of the cached reads it made,
   * added to the bounded envelope as `freshness.cache`. Absent (stdio) means no cache.
   */
  track?: <T>(work: () => Promise<T>) => Promise<{ value: T; freshness: CallFreshness | null }>;
  /** Further local directories to redact (served projects). */
  localProjects?: readonly string[];
}

/** Freshness of a cached read as `pdb serve` reports it. */
export type CallFreshness = { source: string; stale: boolean } & Record<string, unknown>;

/** A per-call repository the served set cannot answer (`pdb serve`). */
export class SelectionRefusal extends Error {
  constructor(readonly code: "repository-unresolved" | "repository-not-served") {
    super(code);
  }
}

export const mcpHelp = `Usage: pdb-mcp [--project PATH] [--repo owner/name] [--agent NAME]
                         [--entry KEY | --harness NAME] [--poll [--poll-interval-minutes N]]
Read-only stdio MCP server for Presidential Daily Briefing. Requires authenticated gh and Node 26+.
Tools: triage_briefing, triage_issue, triage_dependencies, triage_events. Never changes GitHub.
  --project PATH        Local project checkout used to resolve the default repository
  --repo owner/name     Default repository (a tool's repo argument wins)
  --agent NAME          Default agent for focused reads (a tool's agent argument wins)
  --entry KEY           Without an agent, read the name of [agents.KEY] in the project's
                        root pdb.toml, else a legacy agent-inbox.toml entry reported as
                        legacy-not-imported (read only; never created, imported or changed)
  --harness NAME        Without an agent or --entry, select that harness's entry
                        (claude, codex, ori); else the MCP client (ori-SERVER selects
                        ori.SERVER), else the detected harness; otherwise unfocused
  --poll                Opt in: poll the resolved repository while this server runs
                        and record deduplicated events for triage_events (off by default)
  --poll-interval-minutes N
                        Minutes between completed polls (default 30, 1 to 1440; needs --poll)
  --help                Show usage
Stdout carries only the MCP protocol; diagnostics go to stderr.

${impactGuidanceSummary()}`;

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const agentPattern = /^[A-Za-z0-9][\w.-]*$/;

/** Parse startup arguments; throws on invalid input. */
export function mcpArguments(args: string[]): McpOptions & { help?: boolean } {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      repo: { type: "string" },
      agent: { type: "string" },
      entry: { type: "string" },
      harness: { type: "string" },
      poll: { type: "boolean" },
      "poll-interval-minutes": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const interval = values["poll-interval-minutes"];
  if (interval !== undefined && !values.poll)
    throw new Error("--poll-interval-minutes requires --poll.");
  if (
    interval !== undefined &&
    (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > maxPollIntervalMinutes)
  )
    throw new Error(
      `--poll-interval-minutes must be a whole number of minutes from 1 to ${maxPollIntervalMinutes} (24 hours).`,
    );
  if (values.repo !== undefined && !repoPattern.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.agent !== undefined && !agentPattern.test(values.agent))
    throw new Error("--agent must be an agent name such as kavya_sabbagh.");
  if (values.entry !== undefined && values.harness !== undefined)
    throw new Error("Pass either --entry or --harness, not both.");
  if (values.entry !== undefined) validateEntryKey(values.entry);
  if (values.harness !== undefined) validateHarness(values.harness);
  return {
    help: values.help,
    project: values.project === undefined ? undefined : resolve(values.project),
    repo: values.repo,
    agent: values.agent,
    entry: values.entry,
    harness: values.harness,
    ...(values.poll
      ? {
          poll: true,
          pollIntervalMinutes:
            interval === undefined ? pollingDefaults.intervalMinutes : Number(interval),
        }
      : {}),
  };
}

const repo = z.string().regex(repoPattern, "repo must be owner/name").optional();
const agent = z.string().regex(agentPattern, "agent must be an agent name").optional();
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const maxChars = z.number().int().min(1000).max(40000).default(10000);
const since = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d{2}:\d{2})$/, "since must be an ISO timestamp with a time")
  .refine((text) => Number.isFinite(Date.parse(text)), "since must be a valid timestamp")
  .optional();

const last = z
  .string()
  .refine((text) => {
    try {
      parseDuration(text);
      return true;
    } catch {
      return false;
    }
  }, "last must be a positive integer followed by m, h or d, for example 24h")
  .optional();

/**
 * `mode` selects the action briefing (default, unchanged) or the read-only repository catch-up
 * (#171, doc/design/briefing-mode.md slice 4). `last` belongs to briefing mode only, and at most
 * one of `since`/`last` may be given. No checkpoint, cache, file-path or offline input exists.
 */
export const briefingInput = z
  .strictObject({
    repo,
    agent,
    mode: z.enum(["actions", "briefing"]).default("actions"),
    since,
    last,
    limit: z.number().int().min(catchUpLimits.limit.min).max(catchUpLimits.limit.max).optional(),
    maxChars,
    /** Registered role view (#260, doc/design/mcp.md "Role views"): same as CLI --role. */
    role: z
      .string()
      .refine((name) => briefingRoleNames().includes(name), {
        message: `role must be one of ${briefingRoleNames().join(", ")}`,
      })
      .optional(),
    /** Pickup order (#260): same as CLI --order; the CLI default is impact. */
    order: z.enum(pickupOrders).optional(),
    /**
     * One registered section of the role view with its row cap lifted (#311): same IDs and
     * validation as CLI --section; the byte budget still applies.
     */
    section: z
      .string()
      .regex(/^[a-z][a-z-]{0,40}$/, "section must be a registered section ID")
      .optional(),
    /**
     * Label filter (#312): same as repeated CLI --label. A candidate must carry every label
     * (AND); names are resolved against the repository; at most eight distinct.
     */
    // Distinct labels are bounded after case-insensitive deduplication (normalizeLabelRequest),
    // so repeated copies of one label stay idempotent.
    label: z.array(z.string()).min(1).optional(),
    /**
     * Expanded text (#355, doc/design/next-steps-only.md): same as CLI --context. Text only; the
     * structured result is the same either way.
     */
    context: z.boolean().optional(),
  })
  .superRefine((args, ctx) => {
    if (args.section !== undefined) {
      const role = args.role ?? "implementer";
      const ids = roleSectionIds(role);
      if (args.role === "human")
        ctx.addIssue({ code: "custom", path: ["section"], message: "role human has no sections" });
      else if (args.role !== undefined && !ids.includes(args.section))
        ctx.addIssue({
          code: "custom",
          path: ["section"],
          message: `section for role ${role} must be one of: ${ids.join(", ")}`,
        });
    }
    if (args.label !== undefined) {
      const normalized = normalizeLabelRequest(args.label);
      if (!normalized.ok)
        ctx.addIssue({ code: "custom", path: ["label"], message: normalized.why });
      if (args.role === "human")
        ctx.addIssue({
          code: "custom",
          path: ["label"],
          message: "role human takes no label filter",
        });
    }
    for (const key of ["role", "order", "section", "label"] as const)
      if (args.mode === "briefing" && args[key] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} applies only to mode "actions"`,
        });
    if (args.mode === "actions" && args.last !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["last"],
        message: 'last applies only to mode "briefing"; use since for an action briefing',
      });
    if (args.since !== undefined && args.last !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["last"],
        message: "Choose one window source: since or last, not both",
      });
  });

/** MCP never advances a checkpoint; the report says so instead of offering a candidate. */
export const mcpCheckpointPolicy = {
  policy:
    "Read-only MCP briefing: no checkpoint is read or advanced. Use the CLI with --checkpoint PATH to keep a cursor.",
  candidate: null,
} as const;
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const pageLimit = z.number().int().min(1).max(100).default(10);
/** Bounded issue detail (#266): summary by default; other sections are paged. */
export const issueInput = z.strictObject({
  number,
  repo,
  agent,
  maxChars,
  section: z.enum(issueSections).default("summary"),
  offset,
  limit: pageLimit,
});
export const eventsInput = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const dependenciesInput = z.strictObject({
  number,
  repo,
  tree: z.boolean().default(false),
  /** Page of the stable flattened relationship list (#266). */
  offset,
  limit: pageLimit,
});

/**
 * Version-1 envelope, kept by triage_events (polling contract); `result` is its report. The read
 * tools return the bounded version-2 envelope instead (doc/design/mcp-bounded-results.md).
 */
export const envelope = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["events"]),
  status: z.enum(["complete", "incomplete", "error"]),
  selection: selectionSchema,
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type Envelope = z.infer<typeof envelope>;
export { boundedEnvelope };
export type { BoundedEnvelope } from "./bounded.js";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Stable, sanitized failures: no stack traces, subprocess stderr or configuration. */
const failures = {
  "decision-engine-config":
    "Selected repository configuration could not be validated. Use the local CLI diagnostic for the configuration service's repair guidance, repair or restore the configuration, then retry.",
  "decision-engine-role":
    "Datalog next actions require role implementer or designer. Rollback: pdb config set briefing.engine typescript.",
  "decision-engine-failed":
    "Experimental Datalog evaluation failed; no fallback result was returned. Inspect the local CLI diagnostic or roll back: pdb config set briefing.engine typescript.",
  "repository-unresolved":
    "No repository selected. Pass repo as owner/name on this call, or restart the server with --repo owner/name or --project /absolute/project/path, for example: pdb-mcp --project /absolute/project/path",
  "repository-not-served":
    "That repository is not served by this server. Pass one of its repositories as repo (see /api/v1/status), or restart pdb serve with another --repo owner/name.",
  "collection-failed":
    "GitHub evidence could not be collected. Check gh authentication and repository access, then retry.",
  "invalid-window":
    "The requested window starts after the collection start. Pass an earlier since, or a last duration such as 24h.",
  cancelled: "The request was cancelled before collection finished; no result is reported.",
} as const;
type FailureCode = keyof typeof failures;

class Failure extends Error {
  constructor(readonly code: FailureCode) {
    super(failures[code]);
  }
}

type Selection = Envelope["selection"];
type ReadView = BoundedView["view"];

function toolResult(structured: Envelope, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
    ...(structured.status === "error" ? { isError: true } : {}),
  };
}

function plain(value: object): Record<string, unknown> {
  // The CLI's JSON output is exactly this serialization; keep the MCP result byte-compatible.
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Report did not serialize to an object.");
  return parsed as Record<string, unknown>;
}

export { pathPlaceholder, redactLocalText, redactPaths } from "./redact.js";

type IdentitySelection = Omit<Selection, "repository">;

const identitySelection = (identity: ReadIdentity): IdentitySelection => ({
  agent: identity.agent,
  identitySource: identity.source,
  entry: identity.entry,
  triageRole: identity.triageRole,
  identityDiagnostic: identity.diagnostic,
  ...(identity.store ? { identityStore: identity.store } : {}),
});

/** Selection known without any lookup (error envelopes, events). */
const explicitSelection = (tool?: string, startup?: string): IdentitySelection => ({
  agent: tool ?? startup ?? null,
  identitySource: tool ? "tool" : startup ? "startup" : "unresolved",
  entry: null,
  triageRole: null,
  identityDiagnostic: null,
});

/** Build one server for one connection; no state is shared between calls or connections. */
export function createServer(
  options: McpOptions,
  runtime: McpRuntime,
  version = "0.0.0",
): McpServer {
  const server = new McpServer({ name: "pdb", version });
  // Generic path redaction applies only to the service's local diagnostics (doc/design/mcp.md).
  const reader: McpRuntime = { ...runtime, redactDiagnostic: redactLocalText };

  const select = async (
    args: { repo?: string; agent?: string },
    signal: AbortSignal,
  ): Promise<{ selection: Selection & { repository: string }; reader: McpRuntime }> => {
    let repository = args.repo ?? options.repo;
    let project = options.project;
    let callReader = reader;
    if (runtime.served) {
      // pdb serve: the served set decides; a startup repository is never borrowed (#271).
      try {
        const chosen = runtime.served(args.repo);
        repository = chosen.repository;
        project = chosen.project;
        callReader = { ...reader, ...chosen.runtime };
      } catch (error) {
        if (error instanceof SelectionRefusal) throw new Failure(error.code);
        throw error;
      }
    } else if (!repository) {
      // Only a configured project is trustworthy evidence of the default repository. The
      // server's own working directory belongs to whatever launched it (an Ori daemon, say),
      // not to the client's checkout, so never resolve from it (#271, doc/design/mcp.md).
      if (!options.project) throw new Failure("repository-unresolved");
      try {
        repository = await runtime.currentRepository(options.project, signal);
      } catch {
        if (signal.aborted) throw new Failure("cancelled");
        throw new Failure("repository-unresolved");
      }
      if (!repoPattern.test(repository)) throw new Failure("repository-unresolved");
    }
    if (signal.aborted) throw new Failure("cancelled");
    const identity = await resolveReadIdentity({
      toolAgent: args.agent,
      startupAgent: options.agent,
      project,
      repository,
      entry: options.entry,
      harness: options.harness,
      clientName: server.server.getClientVersion()?.name,
      env: runtime.env ?? {},
      git: runtime.git,
      fs: runtime.fs,
    });
    if (signal.aborted) throw new Failure("cancelled");
    return { selection: { repository, ...identitySelection(identity) }, reader: callReader };
  };

  const identityNotice = (selection: Selection): string =>
    selection.identitySource === "unresolved"
      ? `Identity: unresolved; this is an unfocused read. ${selection.identityDiagnostic ?? "Pass agent to focus it."}\n`
      : selection.entry
        ? `Identity: ${selection.agent} from ${selection.identityStore === "legacy-not-imported" ? "legacy agent-inbox.toml (not imported; run pdb config set identity.triage_role ROLE --entry KEY to import it into pdb.toml)" : "pdb.toml"} [agents.${selection.entry}] (${selection.identitySource}).\n`
        : "";

  /**
   * Run one read with per-call selection, then bound the whole result to the response budget
   * (doc/design/mcp-bounded-results.md). Failures map to a sanitized version-2 error envelope.
   */
  const call = async (
    tool: string,
    view: ReadView,
    args: { repo?: string; agent?: string; number?: number },
    signal: AbortSignal,
    maxChars: number,
    read: (
      selection: Selection & { repository: string },
      reader: McpRuntime,
    ) => Promise<{
      status: "complete" | "incomplete";
      /** Build the view from redacted base inputs. */
      build: (base: ViewBase, redact: <T>(value: T) => T) => BoundedView;
    }>,
  ): Promise<ToolResult> => {
    let selection: Selection = {
      repository: args.repo ?? options.repo ?? null,
      ...explicitSelection(args.agent, options.agent),
    };
    try {
      const { selection: selected, reader: callReader } = await select(args, signal);
      selection = selected;
      const work = () => read(selected, callReader);
      const { value: outcome, freshness } = runtime.track
        ? await runtime.track(work)
        : { value: await work(), freshness: null };
      if (signal.aborted) throw new Failure("cancelled");
      // Diagnostics (e.g. config errors) can name local directories; never return them.
      const known = localPaths(options.project, ...(runtime.localProjects ?? []));
      const redact = <T>(value: T): T => redactPaths(value, known);
      // The INCOMPLETE notice is added by boundedResult from the view's final status.
      const notices = identityNotice(selection)
        ? [redact(identityNotice(selection).trimEnd())]
        : [];
      // pdb serve: a stale cached result is never presented as complete (doc/design/serve.md).
      if (freshness?.stale)
        notices.push(
          `Stale: served from the cache because the live read failed; facts may have changed since ${String(freshness.observedAt)}.`,
        );
      const built = outcome.build(
        {
          repository: selected.repository,
          selection,
          status: freshness?.stale ? "incomplete" : outcome.status,
          notices,
          maxChars,
        },
        redact,
      );
      // Additive: the server cache's freshness block, inside the existing freshness record.
      if (freshness) built.freshness = { ...built.freshness, cache: freshness };
      return boundedResult(built);
    } catch (error) {
      // pdb serve: the cache's sanitized GitHub failure codes pass through unchanged.
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        /^GITHUB_[A-Z_]+$/.test(error.code) &&
        !signal.aborted
      )
        return errorResult(tool, view, selection, args.number, error.code, error.message);
      // #311: an argument the resolved role rejects (for example a section ID under the
      // default role) is the caller's to fix, with the supported choices; not a GitHub failure.
      if (error instanceof BriefingArgumentError && !signal.aborted)
        return errorResult(tool, view, selection, args.number, "invalid-argument", error.message);
      // #312: a label lookup that failed is not "no such label" and not a collection failure.
      if (error instanceof LabelFilterUnresolved && !signal.aborted)
        return errorResult(tool, view, selection, args.number, error.code, error.message);
      const code: FailureCode =
        error instanceof Failure || error instanceof BriefingEngineError
          ? error.code
          : signal.aborted
            ? "cancelled"
            : "collection-failed";
      return errorResult(tool, view, selection, args.number, code, failures[code]);
    }
  };

  server.registerTool(
    "triage_briefing",
    {
      title: "Triage briefing",
      description:
        'Datalog next actions by default (implementer view unless role is supplied). Explicit TypeScript rollback: pdb config set briefing.engine typescript. Evidence-linked action briefing for a GitHub repository: what needs attention and what to pick up next. Call at the start of work or with since to catch up. mode "briefing" returns the repository-wide what-changed report for a window (since, or last such as 24h; default last 24h); it never reads or advances a checkpoint. Actions default to ten next steps; catch-up defaults to five rows per section. In actions mode, role (implementer or designer) returns the blended queue for that role (rankedActions, role.next, estimation, impactEstimation) exactly as the CLI --role, and order (impact, oldest, newest) matches CLI --order. role human returns the human briefing (human): questions, attention and sign-offs owed by the human named in agent, explicit before inferred; read-only. The text lists only the next steps; context true adds the background lines (structured data is the same either way). PR acceptance follows the declared review.policy of the repository: undeclared keeps the legacy rule; codex-or-coderabbit accepts an authenticated current-head review from either provider, while a finding from either blocks and CI, protections and authority stay independent.',
      inputSchema: briefingInput,
      outputSchema: boundedEnvelope,
      annotations,
    },
    async (args, ctx) =>
      args.mode === "briefing"
        ? call(
            "triage_briefing",
            "repository-briefing",
            args,
            ctx.mcpReq.signal,
            args.maxChars,
            async (selection, rt) => {
              const now = rt.now ?? (() => new Date());
              let snapshot;
              try {
                ({ snapshot } = await collectBriefing(
                  rt.collect,
                  selection.repository,
                  { since: args.since, last: args.last },
                  now,
                  ctx.mcpReq.signal,
                ));
              } catch (error) {
                if (error instanceof WindowRefusal) throw new Failure("invalid-window");
                throw error;
              }
              const built = catchUp(snapshot, {
                agent: selection.agent ?? undefined,
                limit: args.limit ?? (args.mode === "briefing" ? catchUpLimits.limit.default : 10),
                now,
              });
              // Completeness as the CLI judges it, before the checkpoint candidate is withheld.
              const complete = built.checkpoint.candidate !== null;
              const report = { ...built, offline: null, checkpoint: mcpCheckpointPolicy };
              return {
                status: complete ? "complete" : "incomplete",
                build: (base, redact) => repositoryBriefingView(base, redact(plain(report))),
              };
            },
          )
        : call(
            "triage_briefing",
            "briefing",
            args,
            ctx.mcpReq.signal,
            args.maxChars,
            async (selection, rt) => {
              const read = await readBriefing(rt, {
                repository: selection.repository,
                // The human role names its human only explicitly (doc/design/human-briefing.md).
                agent:
                  args.role === "human" && selection.identitySource !== "tool"
                    ? undefined
                    : (selection.agent ?? undefined),
                since: args.since ? new Date(args.since).toISOString() : undefined,
                limit: args.limit ?? (args.mode === "briefing" ? catchUpLimits.limit.default : 10),
                maxChars: args.maxChars,
                role: args.role,
                ...(args.section ? { section: args.section } : {}),
                ...(args.label ? { labels: args.label } : {}),
                order: args.order ?? "impact",
                context: args.context,
                signal: ctx.mcpReq.signal,
              });
              if (read.kind === "unavailable") throw new Failure("collection-failed");
              return {
                status: read.complete ? "complete" : "incomplete",
                build: (base, redact) =>
                  briefingView(base, redact(plain(read.report)), { context: args.context }),
              };
            },
          ),
  );

  server.registerTool(
    "triage_issue",
    {
      title: "Triage issue intake",
      description:
        "Bounded intake for one issue, even if closed: section summary (default: state, labels, ownership, assessments, findings, dependencies and counts), or a page (offset, limit) of body lines, discussion comments or related pull requests. Diagnoses transferred, missing or inaccessible issues. Call before working on a ticket.",
      inputSchema: issueInput,
      outputSchema: boundedEnvelope,
      annotations,
    },
    async (args, ctx) =>
      call(
        "triage_issue",
        "issue",
        args,
        ctx.mcpReq.signal,
        args.maxChars,
        async (selection, rt) => {
          const read = await readBriefing(rt, {
            repository: selection.repository,
            agent: selection.agent ?? undefined,
            issue: args.number,
            limit: 10,
            maxChars: args.maxChars,
            signal: ctx.mcpReq.signal,
          });
          if (read.kind === "unavailable")
            return {
              status: "incomplete",
              build: (base, redact) =>
                unavailableIssueView(
                  base,
                  args.number,
                  redact(plain(read.diagnosis)),
                  redact(read.text),
                ),
            };
          const page = { offset: args.offset, limit: args.limit };
          const navigation = {
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.agent ? { agent: args.agent } : {}),
          };
          return {
            status: read.complete ? "complete" : "incomplete",
            build: (base, redact) =>
              issueView(
                base,
                redact(plain(read.report)),
                args.number,
                args.section,
                page,
                navigation,
              ),
          };
        },
      ),
  );

  server.registerTool(
    "triage_dependencies",
    {
      title: "Native issue dependencies",
      description:
        "Native GitHub blocked-by/blocking relationships for one issue as a paged (offset, limit) list with relation, depth and path; with tree, the transitive graph and cycles. Call before claiming or ordering work.",
      inputSchema: dependenciesInput,
      outputSchema: boundedEnvelope,
      annotations,
    },
    async (args, ctx) =>
      call(
        "triage_dependencies",
        "dependencies",
        { repo: args.repo, number: args.number },
        ctx.mcpReq.signal,
        10000,
        async (selection, rt) => {
          const read = await readDependencies(
            rt,
            selection.repository,
            args.number,
            args.tree,
            ctx.mcpReq.signal,
          );
          const navigation = { ...(args.repo ? { repo: args.repo } : {}), tree: args.tree };
          return {
            // Skipped (unserved) nodes are judged by the view, in sourceCompleteness too.
            status: "complete",
            build: (base, redact) =>
              dependenciesView(
                base,
                redact(plain(read.report)),
                args.number,
                { offset: args.offset, limit: args.limit },
                navigation,
              ),
          };
        },
      ),
  );

  server.registerTool(
    "triage_events",
    {
      title: "Triage events",
      description:
        "Deduplicated events detected by this server's optional poller (--poll) for its watched repository, after an optional cursor. Read-only and nondestructive; events are inspection candidates, never approval. Reports disabled status when polling is off.",
      inputSchema: eventsInput,
      outputSchema: envelope,
      annotations,
    },
    async (args, ctx) => {
      const watcher = runtime.watcher ?? null;
      const repository = watcher?.repository ?? null;
      // The startup agent is echoed; an over-long one is shortened, and the text says so.
      const echoed = explicitSelection(undefined, options.agent);
      const shortenedAgent = echoed.agent !== null && echoed.agent.length > fieldLimit;
      const selection = {
        repository,
        ...echoed,
        agent: shortenedAgent
          ? `${echoed.agent!.slice(0, fieldLimit - truncationMarker.length)}${truncationMarker}`
          : echoed.agent,
      };
      const echoNotice = shortenedAgent
        ? `Startup agent longer than ${fieldLimit} characters shortened (${truncationMarker}).\n`
        : "";
      if (ctx.mcpReq.signal.aborted)
        return toolResult(
          {
            schemaVersion: 1,
            kind: "events",
            status: "error",
            selection,
            result: null,
            error: { code: "cancelled", message: failures.cancelled },
          },
          `Error (cancelled): ${failures.cancelled}\n`,
        );
      // The same whole-result budget as the read tools (#266). A smaller page is re-read from
      // the log, so nextCursor and more stay exact and no event is skipped.
      for (let limit = args.limit; ; limit = Math.floor(limit / 2)) {
        const report = eventsReport(watcher, args.cursor, limit);
        const reduced =
          limit < args.limit
            ? `Page reduced from ${args.limit} to ${limit} event(s) to fit the ${budgetBytes}-byte response budget; continue from nextCursor.\n`
            : "";
        const result = toolResult(
          {
            schemaVersion: 1,
            kind: "events",
            status: report.complete ? "complete" : "incomplete",
            selection,
            result: redactPaths(plain(report), localPaths(options.project)),
            error: null,
          },
          echoNotice + reduced + redactPaths(eventsText(report), localPaths(options.project)),
        );
        if (resultBytes(result) <= budgetBytes) return result;
        if (limit <= 1) {
          const message = `One event exceeds the ${budgetBytes}-byte response budget. Recovery: call triage_briefing for current evidence.`;
          return toolResult(
            {
              schemaVersion: 1,
              kind: "events",
              status: "error",
              selection,
              result: null,
              error: { code: budgetErrorCode, message },
            },
            `Error (${budgetErrorCode}): ${message}\n`,
          );
        }
      }
    },
  );

  return server;
}

/** Sanitized version-2 error result for a read tool, bounded like every other result. */
function errorResult(
  tool: string,
  view: ReadView,
  selection: Selection,
  number: number | undefined,
  code: string,
  message: string,
): ToolResult {
  return boundedError({
    tool,
    view,
    repository: selection.repository,
    subject: number === undefined ? null : { type: "issue", number },
    selection,
    freshness: null,
    sourceCompleteness: null,
    code,
    message,
  });
}

/** Production boundaries: authenticated gh through the existing argument-array runners. */
export const defaultRuntime = (options: McpOptions): McpRuntime => ({
  collect,
  dependencyReport,
  currentRepository,
  // Provenance authors' permissions for the paired assessments (#247), cached per read.
  rest: ghRest,
  // Delivery evidence (#192): PR reads and target compares by recorded identity, bounded.
  queryWith: ghQueryWith,
  env: process.env,
  // Every runtime piece that reads local state resolves against the configured project, not
  // the server's working directory: estimation settings and the workflow-guide opt-out (#71).
  estimation: options.project ? { cwd: options.project } : undefined,
  guide: options.project ? { cwd: options.project } : undefined,
});

/**
 * Bind the opt-in watcher to the one explicit startup target (#271, #291). Refuses before any
 * repository resolution, collection or timer when neither --repo nor --project was given; a
 * per-tool repo never binds this process-wide watcher. The caller starts the returned watcher.
 */
export async function bindPolling(
  options: McpOptions,
  runtime: McpRuntime,
  clock: Clock = systemClock,
): Promise<Watcher | undefined> {
  if (!options.poll) return undefined;
  // Polling watches exactly one explicitly resolved repository, never arbitrary targets.
  // As for tool calls, never watch whatever repository the launch directory holds (#271).
  if (!options.repo && !options.project)
    throw new Error("--poll needs --repo owner/name or --project /absolute/project/path.");
  const repository = options.repo ?? (await runtime.currentRepository(options.project));
  if (!repoPattern.test(repository)) throw new Error("--poll needs a resolvable --repo.");
  runtime.collect = sharedCollect(runtime.collect);
  runtime.watcher = new Watcher(
    { repository, intervalMinutes: options.pollIntervalMinutes },
    { collect: runtime.collect, clock },
  );
  return runtime.watcher;
}
