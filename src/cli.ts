#!/usr/bin/env node
import { resolveEngineSetting } from "./config/engine-setting.js";
import { resolveReviewPolicy } from "./config/review-setting.js";
/** One read-only intake command. Contract: doc/pdb-cli.md. */
import { realpathSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  collect,
  currentRepository,
  collectIssueFocus,
  ghQuery,
  ghRest,
  historyComplete,
  IssueUnavailable,
  permissionLookup,
  prop,
} from "./github/github.js";
import {
  applyDependencyChange,
  dependencyChangeText,
  dependencyReport,
  dependencyReportIncomplete,
  dependencyText,
  readDependencyInventory,
  treeNodeLimit,
  treeNodeMaximum,
  ghRun,
  planDependencyChange,
} from "./github/dependencies.js";
import { briefingRoleNames } from "./briefing/roles.js";
import { doctorStaleHours, ticketDoctor, ticketDoctorText } from "./workflow/ticketdoctor.js";
import { diagnoseClosedDrift, diagnoseDelivery } from "./workflow/deliverydoctor.js";
import { deliveryRead, withDeliveryCompleteness } from "./workflow/deliveryread.js";
import {
  applyPlan,
  claimPolicy,
  claimText,
  planClaim,
  planNeedsHuman,
  planQuestionResolution,
  type ClaimPlan,
  type ClaimResult,
  planRelease,
} from "./workflow/claims.js";
import {
  admissionFor,
  planClaimResume,
  planClaimWait,
  planWaitOnQuestion,
  stillWaitingFor,
  verifyTransition,
} from "./workflow/retained.js";
import { cachedCheckForUpdate } from "./updates/updatecache.js";
import { installedVersion, optOutEnv, legacyOptOutEnv, updateAdvisory } from "./updates/updates.js";
import { defaultStaleHours } from "./workflow/team.js";
import { migrationPlanText, planMigration } from "./github/migration.js";
import { presentBriefing, unavailableText } from "./briefing/service.js";
import { runBriefing } from "./briefing/catchupcli.js";
import type { BriefingFiles } from "./briefing/catchupcli.js";
import {
  briefingProcess,
  fullGuideJson,
  fullGuideText,
  GUIDE_CONFIG_KEY,
  guideRules,
  mutatingCommands,
  PROCESS_COMMAND,
  resolveGuideSetting,
} from "./briefing/process.js";
import type { GuideRuntime } from "./briefing/process.js";
import { defaultPickupOrder, pickupOrders } from "./briefing/ranking.js";
import type { PickupOrder } from "./briefing/ranking.js";
import { complexityGuidanceJson, complexityGuidanceText } from "./estimation/complexity.js";
import { impactGuidanceJson, impactGuidanceText } from "./estimation/impact.js";
import { declaredRulesContext } from "./rules/declared-context.js";
import { runConfig } from "./config/configcli.js";
import type { ConfigRuntime } from "./config/configcli.js";
import { estimateUsage, runEstimate } from "./estimation/estimate.js";
import {
  applyDeliverables,
  deliverablesArguments,
  deliverablesHelp,
  deliverablesText,
  submitArguments,
  submitHelp,
  reworkAuthority,
  reworkMembershipRequest,
  planDeliverables,
} from "./workflow/deliverables.js";
import { markerTrust } from "./workflow/delivery.js";
import {
  applyComplete,
  completeArguments,
  completeHelp,
  completeText,
  planComplete,
} from "./workflow/completion.js";
import type { LabelEstimationRuntime } from "./estimation/complexitylabels.js";
import { metricStatus } from "./estimation/complexitylabels.js";
import { impactMetric } from "./estimation/metrics.js";
import type { EstimateRuntime } from "./estimation/estimate.js";
import { localDoctor, localDoctorExitCode, localDoctorText } from "./config/localdoctor.js";
import type { LocalDoctorRuntime } from "./config/localdoctor.js";
import type { GhRun } from "./github/dependencies.js";
import type { Query, Rest } from "./github/github.js";
import type { Snapshot } from "./github/types.js";
import {
  readPullRequest,
  readReviewHistory,
  readTeam,
  readWho,
  readWhoLive,
} from "./workflow/readservices.js";
import {
  directImpact,
  directImpactText,
  repositoryImpact,
  repositoryImpactText,
} from "./briefing/dependencyimpact.js";
import { readTicketStatus, ticketLimits, ticketStatusText } from "./workflow/ticketstatus.js";
import { ghAuthContext, runServe } from "./serve.js";
import { runQuotas } from "./github/quotascli.js";
import type { QuotasRuntime } from "./github/quotascli.js";
import {
  createIssue,
  defaultOperationId,
  defaultReadFile,
  ghPost,
  issueCreateExitCode,
  issueCreateHelp,
  issueCreateText,
  issueCreateUsage,
  IssueCreateUsageError,
  readStdinBounded,
} from "./workflow/issuecreate.js";
import type { IssueCreateRuntime } from "./workflow/issuecreate.js";
import type { ServeRuntime } from "./serve.js";

/** Parsed `deps` arguments: help, a migration plan, a native change, or a read. */
export type DepsArguments =
  | { help: true; repo?: undefined }
  | { help?: undefined; migrate: "plan"; file: string; repo?: string; json?: boolean }
  | {
      help?: undefined;
      action: "add" | "remove";
      number: number;
      on: number[];
      note: string;
      dryRun: boolean;
      repo?: string;
      json?: boolean;
    }
  | {
      help?: undefined;
      top: true;
      limit: number;
      repo?: string;
      json?: boolean;
      /** Fills the suggested claim command (NAME otherwise). */
      agent?: string;
      /** The viewer's platform for platform-restricted pickup, as the briefing's --platform. */
      platform?: string;
    }
  | {
      help?: undefined;
      number: number;
      repo?: string;
      json?: boolean;
      tree?: boolean;
      /** `--max-nodes`: the explicit tree walk's node limit (#196). */
      maxNodes?: number;
      /** Fills the suggested claim command (NAME otherwise). */
      agent?: string;
      /** The viewer's platform for platform-restricted pickup, as the briefing's --platform. */
      platform?: string;
    };

/** Injected services for `main`; tests replace the GitHub-facing ones. */
export interface Runtime {
  collect: typeof collect;
  /** Focused issue read for `who N` (issue-detail-v1, #367); default: the gh collector. */
  collectIssueFocus?: typeof collectIssueFocus;
  currentRepository: typeof currentRepository;
  dependencyReport?: typeof dependencyReport;
  /** Open-issue inventory for `deps --top` (dependency-discovery-v1, #196). */
  dependencyInventory?: typeof readDependencyInventory;
  planDependencyChange?: typeof planDependencyChange;
  ghRun?: GhRun;
  planMigration?: typeof planMigration;
  migrationRuntime?: Parameters<typeof planMigration>[1];
  query?: Query;
  /** Read-only REST boundary; claim and release use it for comment authors' permissions (#212). */
  rest?: Rest;
  now?: () => Date;
  updateCheck?: typeof cachedCheckForUpdate;
  stderr?: (text: string) => void;
  /** Filesystem, git and working directory for `config`; tests never touch the real checkout. */
  config?: ConfigRuntime;
  /** Filesystem, git, GitHub GraphQL API and clock for `estimate N`. */
  estimate?: EstimateRuntime;
  /** Working directory, filesystem and process probe for `doctor` (#64). */
  localDoctor?: LocalDoctorRuntime;
  /** Filesystem, git and working directory for the briefing's estimation settings (#122). */
  estimation?: LabelEstimationRuntime;
  /** Filesystem, git and working directory for the workflow-guide setting (#71). */
  guide?: GuideRuntime;
  /** Checkpoint/cache files for `briefing` (#170); tests inject failures per phase. */
  briefingFiles?: BriefingFiles;
  /** Listener, gh login, clock, output and signals for `serve` (#373). */
  serve?: ServeRuntime;
  /** POST, clock, operation ID, body input and stderr for `issue create` (#199). */
  issueCreate?: Partial<IssueCreateRuntime>;
  /** gh REST, login resolver, host and clock for `quotas` (#547). */
  quotas?: Partial<QuotasRuntime>;
}

type Output = (text: string) => Promise<void>;

export const help = `Usage: pdb [options]
       (from a source checkout: npm run pdb -- [options])
Presidential Daily Briefing: evidence-linked actions for coding agents. Requires authenticated gh and Node 26+.
Next-action default: Datalog, implementer view; --role designer selects design work.
Rollback: pdb config set briefing.engine typescript.
  briefing [--last 24h | --since ISO | --checkpoint PATH]  Read-only repository catch-up:
                        what changed and what needs attention (briefing --help)
  issue create --title TEXT [--body TEXT | --body-file PATH|-] [--label L]... [--dry-run]
                        Create one issue in --repo (default: this checkout), shown before
                        writing; one request, never retried; partial/unknown exit 2 (issue create --help)
  deps N [--tree]       Read native upstream/downstream dependencies (deps --help)
  deps add|remove N --on M --note WHY [--dry-run]  Change native dependencies
  estimate --help       Complexity sizing guidance (XS..XXL)
  estimate --help --metric impact  Impact (benefit) estimation guidance (XS..XXL)
  estimate N --size S --rationale TEXT [--assumption A]... [--replace OLD]  Record a size
                        as a complexity:S label with provenance (estimate --help);
                        --metric impact records a benefit estimate as impact:S
  pr N                  Why is pull request N not progressing? Every blocker at once
                        under the declared review.policy (pdb config help): with
                        codex-or-coderabbit either provider's current-head acceptance
                        covers review; a finding from either still blocks
  pr N --history        Why does PR N keep failing review? Rounds, findings, recurring files
  claim N --agent NAME [--branch B] [--platform P] [--rework] [--dry-run]  Claim an eligible ticket;
                        --rework reclaims your own awaiting-review issue to fix review feedback;
                        with delivery records only the ticket-responsible agent may, and the
                        claim is followed by a membership-open record (finish with submit)
  release N --agent NAME --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL]
                        [--dry-run]  Hand over your claim in one operation: record the outcome,
                        release agent:NAME and set readiness (ready; incomplete=parked, still
                        pickable; done+open PR -> status:awaiting-review; done without one ->
                        no readiness, for inspection). Never closes; retry is safe (release --help)
  deliverables N attach|detach|retarget|handoff|membership|attest|reassign|reset|void
                        --agent NAME ... [--dry-run]  Record required deliverables and
                        responsibility on the issue (deliverables --help)
  submit N --agent NAME [--pr URL...] [--target owner/name:branch] [--membership open] [--dry-run]
                        Hand over your PRs: record them, release your claim and set
                        status:awaiting-review; you stay responsible for follow-up (submit --help)
  complete N --agent NAME [--dry-run]  Verify delivery from fresh evidence (every required PR
                        merged into its live target) and only then record completion and close
                        the issue as completed; never reopens or merges (complete --help)
  claim wait N --agent NAME (--question URL | --blocked-by owner/name#M) --why TEXT [--dry-run]
                        Keep your claim while it waits on a question or an open native blocker;
                        while every other claim of yours verifiably waits, you may claim one more
  claim resume N --agent NAME [--dry-run]  Make a waiting claim active again once its blocker
                        cleared (never automatic; refused while another claim is active)
  needs-human N --agent NAME --designer NAME --why TEXT --question TEXT... [--release] [--dry-run]
                        Record questions for a designer and mark the ticket decision-needed;
                        keeps your claim waiting on the question (--release relinquishes it)
  question resolve|withdraw N --agent NAME --question URL --why TEXT [--dry-run]
                        Record that a needs-human question was answered or withdrawn (explicit,
                        with a reason; never inferred from replies, labels or closure)
  quotas [--json] [--refresh | --offline]  Read-only GitHub API allowance per resource for
                        the gh login: one /rate_limit read, no repository scan; secondary
                        limits are unmetered (quotas --help)
  serve --repo owner/name | --project PATH [--port N]  Foreground local HTTP server: read-only
                        JSON API and HTTP MCP over a short-lived memory cache (serve --help)
  team [--stale-hours N]  Read-only: each agent's claims, linked PRs, activity and warnings
  who N [--stale-hours N]  Read-only: who is working on ticket N? Claims, PRs, activity,
                        handoff evidence and contradictions in one operation
  ticket N [--limit-prs N] [--max-chars N]  Read-only: one ticket and its associated PRs in
                        one bounded read: state, delivery, PR checks/reviews, ownership, direct
                        blockers, discussion excerpts and next step (ticket --help)
  ticket-doctor [--stale-hours N] [--limit N] [--since ISO]  Read-only consistency scan of all open tickets
                        (including conflicting complexity labels), with suggested correction
                        commands per finding (never run; claim commands only for the claimant)
                        and delivery drift; --since also checks closed issues with delivery
                        records updated in that window (closed but not delivered; open PRs left
                        after a not-planned closure). Never reopens anything.
  doctor [--agent NAME] [--role NAME] [--entry KEY | --harness NAME]  Read-only local
                        configuration checks: Node, gh install/auth, checkout, pdb.toml
                        presence (a legacy agent-inbox.toml entry is reported as not
                        imported), parse, Git ignore vs tracked, selected entry, persisted name
                        and triage_role; exact next commands per check, nothing repaired
  config get KEY | set KEY VALUE | list | convert | help [KEY]  Repository settings
                        in .github/triage.toml of this checkout (an earlier
                        .github/triage.json is read until config convert); identity.name and
                        identity.triage_role in local pdb.toml (the first set imports a
                        matching legacy agent-inbox.toml entry once, never changing it), entry
                        chosen by --entry KEY, --harness NAME or the detected harness
  --repo owner/name     Repository (default: current gh checkout)
  --json                Versioned structured output (from a checkout: npm run --silent pdb)
  --issue N             Include full issue body/history, even if closed; diagnoses
                        transferred, missing or forbidden issues instead of failing
  --include-transferred With --issue: follow a transfer to the destination's intake
  --since ISO           Include changed issues/PRs in all states since timestamp
  --checkpoint PATH     Read last successful window; advance only after complete live output
  --cache PATH          Save full successful snapshot atomically
  --offline             Read explicit cache; no GitHub queries/checkpoint advancement
  --full                Expanded version-1 report
  --agent NAME          Your identity: attention:NAME first, then agent:NAME work
  --role NAME           Shape the compact briefing for implementer (attention, PR follow-up,
                        own work, pickup, unblock candidates, stale claims) or designer
                        (attention, decisions, documentation, design review, new design).
                        Presentation only: never authority; addressed attention always shown.
                        Both roles rank NEXT STEPS as one blended queue (rankedActions): attention,
                        PR follow-up, designer duties, easy wins, assessments (estimate-complexity
                        or assess-impact, blocked tickets included), ordinary, unfavorable work.
                        --role human lists the questions, attention requests and sign-offs a
                        human (named with --agent NAME) is asked for, explicit before inferred,
                        with what each blocks; read-only, never a claim
  --platform P          Your platform (e.g. claude-code); platform:* tickets need a match.
                        Without it, restricted tickets are inspection context, not pickup
  --order MODE          Pickup order only: impact (default: urgency, immediate unlocks,
                        incomplete first, oldest), or oldest/newest (creation time alone,
                        ignoring urgency/impact; both still shown). Never changes eligibility,
                        claims, addressed attention or the PR/owned-work groups above pickup.
                        With a role, oldest/newest merges unclaimed easy-win, ordinary and
                        unfavorable pickup into one age-ordered group; assessments, attention,
                        PR follow-up, designer duties and own claims keep their positions
  --estimate            Focus on the estimation queue (unestimated or stale sizes, blocked
                        tickets included) first. Not needed to see estimates: --role
                        implementer ranks them in NEXT STEPS. Never claims or reserves;
                        disabled complexity hides it
  --stale-hours N       Flag claims with no ticket/linked-PR activity for N hours (default 48)
  --max-chars N         Compact text budget (default 10000)
  --context             Add background sections, totals and engine metadata to the text; by
                        default it holds only the next steps and material warnings (JSON is
                        always complete)
  --limit N             Next steps (default 10)
  --no-update-check     Skip the npm version check (also ${optOutEnv}=1)
  version               Show the installed version and the update check result
  --guide | --no-guide  Show or hide the compact workflow guide in this briefing
                        (default off; repository setting: config set ${GUIDE_CONFIG_KEY} false)
  process [--json]      Full workflow guide from the registered policy; local, no GitHub
  rules [--json] [--rule ID] [--role R]
                        The decision policy compiled to English from its Datalog clauses;
                        local, no GitHub (pdb rules --help)
  --help                Show usage
Workflow (generated from the registered policy):
${guideRules()
  .filter((rule) => ["attention-first", "pickup-eligibility"].includes(rule.id))
  .map((rule) => `  ${rule.summary}`)
  .join("\n")}
  Details: ${PROCESS_COMMAND}
Exit: 0 complete; 2 incomplete evidence; 1 invalid arguments/API/cache failure.
The briefing never changes GitHub; only ${mutatingCommands().join(", ")} do;
config set/convert change only the local .github/triage.toml/.json or pdb.toml (never agent-inbox.toml). Hints require inspection.
`;
export const ticketHelp = `Usage: pdb ticket N [--repo owner/name] [--agent NAME] [--platform NAME]
                    [--json] [--limit-prs N] [--max-chars N]
Read-only consolidated view of one ticket and its associated pull requests (#197).
Reads the issue, its direct native dependencies, comments, trusted delivery records and every
PR GitHub links as closing it (closed and merged included), then the shared pr-status read for
at most --limit-prs PRs, required delivery members first. No repository catch-up.

  --limit-prs N         Detailed PR reads, 1-${ticketLimits.maxPullRequests} (default ${ticketLimits.defaultPullRequests}); PRs beyond it are listed as
                        omitted, unknown evidence, never absent
  --max-chars N         Text budget (default 10000), never exceeded: whole rows, actionable first,
                        then "Truncated due to maximum size." (shorter marker for tiny limits)
  --json                Versioned ticket-status document (never sliced by --max-chars)
  --agent NAME          Focus identity, reported only; never authorization
  --platform NAME       Focus platform, reported only
  --repo owner/name     Repository (default: the current checkout's)
  --help                Show usage

Exit 0: complete evidence. 2: useful but incomplete evidence. 1: invalid arguments or no usable
read (including an unavailable issue). The full intake stays: pdb --issue N --json.
`;

export const depsHelp = `Usage: pdb deps N [--tree [--max-nodes K]] [--agent NAME] [--platform P] [--json] [--repo owner/name]
       pdb deps --top [--limit K] [--agent NAME] [--platform P] [--json] [--repo owner/name]
       pdb deps add N --on M [--on K] --note WHY [--dry-run] [--json]
       pdb deps remove N --on M [--on K] --note WHY [--dry-run] [--json]
       pdb deps migrate --plan FILE [--repo owner/name] [--json]
(From a source checkout, use npm run pdb -- deps ...)
deps N reads native GitHub issue dependencies for issue N (read-only), and answers from direct
edges whether N can start now, which dependants become pickable when it completes, which stay
blocked by other blockers, and one concrete next action. Unknown evidence is a lower bound.
deps --top ranks the repository's open issues by direct edges only (no discussion): what can
start now, and which work that is not pickable now would unlock the most on completion.
deps add/remove make N blocked (or no longer blocked) by each M, after fresh live checks:
refuses self-dependencies, pull requests, missing issues and cycles; an edge that already
exists (add) or is absent (remove) is a no-op. Posts one comment on N with the note.
Changes no labels.
  --tree                Explicit, expensive diagnosis: follow blockers and dependants
                        transitively (at least one request per issue, more for issues
                        with over 100 edges), breadth first; report cycles.
                        A walk stopped by its node limit says so and lists what it did not
                        read; it is never reported as a complete graph
  --agent NAME          Your agent name, filled into the suggested claim command (else NAME)
  --platform P          Your platform, for platform-restricted pickup (as the briefing's)
  --top                 Repository-wide direct-impact ranking (read-only, bounded)
  --limit K             Entries per --top list (default 10, at most 50)
  --max-nodes K         Tree node limit (default ${treeNodeLimit}, at most ${treeNodeMaximum}; --tree only)
  --on M                Blocker issue number (repeatable; add/remove only)
  --note WHY            Reason recorded in the comment (required for add/remove)
  --dry-run             Show the exact changes and comment; make none
  --json                Versioned structured output (from a checkout: npm run --silent pdb)
  --repo owner/name     Repository (default: current gh checkout)
  --help                Show usage
deps migrate --plan reads only: it writes a report of how \`Depends on\` text and blocked:work
labels map to native dependencies. Record edges with deps add; automatic apply is deferred (#48).
Exit (deps N): 0 complete; 2 incomplete evidence (a tree stopped by its node limit, a quota
refusal or unserved repositories, or native evidence unknown); 1 invalid arguments/API failure.
Exit (add/remove): 0 all done; 2 partly done (refused/skipped/failed items listed); 1 nothing
done or invalid arguments/API failure.
`;
/** Parse and validate `pdb ticket` arguments (shared with suggested-command tests, #196). */
export function ticketArgumentsFor(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      agent: { type: "string" },
      platform: { type: "string" },
      "limit-prs": { type: "string" },
      "max-chars": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: true as const };
  if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
    throw new Error(
      "Usage: pdb ticket N [--repo owner/name] [--agent NAME] [--platform NAME] [--json] [--limit-prs N] [--max-chars N]",
    );
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(values.agent))
    throw new Error("--agent must be an agent name such as kavya_sabbagh.");
  if (values.platform !== undefined && !/^[\w.-]+$/.test(values.platform))
    throw new Error("--platform must be a platform name such as claude-code.");
  const bounded = (text: string | undefined, fallback: number, max: number, option: string) => {
    const value = text ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
      throw new Error(`${option} must be an integer from 1 to ${max}.`);
    return Number(value);
  };
  const limitPrs = bounded(
    values["limit-prs"],
    ticketLimits.defaultPullRequests,
    ticketLimits.maxPullRequests,
    "--limit-prs",
  );
  const maxChars = bounded(values["max-chars"], 10_000, Number.MAX_SAFE_INTEGER, "--max-chars");
  return { help: false as const, values, positionals, limitPrs, maxChars };
}
export function depsArgumentsFor(args: string[]): DepsArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      tree: { type: "boolean" },
      "max-nodes": { type: "string" },
      agent: { type: "string" },
      platform: { type: "string" },
      top: { type: "boolean" },
      limit: { type: "string" },
      help: { type: "boolean" },
      on: { type: "string", multiple: true },
      note: { type: "string" },
      "dry-run": { type: "boolean" },
      plan: { type: "string" },
    },
  });
  if (values.help) return { help: true };
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const number = (text: string | undefined): number | null =>
    /^[1-9]\d*$/.test(text ?? "") && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  if (values.agent !== undefined) {
    if (["migrate", "add", "remove"].includes(positionals[0] ?? ""))
      throw new Error("--agent applies only to deps N and deps --top.");
    if (!/^[A-Za-z0-9][\w.-]*$/.test(values.agent))
      throw new Error("--agent must be an agent name such as kavya_sabbagh.");
  }
  if (values.platform !== undefined) {
    if (["migrate", "add", "remove"].includes(positionals[0] ?? "") || values.tree)
      throw new Error("--platform applies only to deps N and deps --top.");
    if (!/^[\w.-]+$/.test(values.platform))
      throw new Error("--platform must be a platform name such as claude-code.");
  }
  // --max-nodes belongs to deps N --tree alone: refuse it everywhere else, before any branch.
  if (values["max-nodes"] !== undefined) {
    if (["migrate", "add", "remove"].includes(positionals[0] ?? "") || !values.tree)
      throw new Error("--max-nodes applies only to deps N --tree.");
    const parsed = number(values["max-nodes"]);
    if (parsed === null || parsed > treeNodeMaximum)
      throw new Error(`--max-nodes must be 1–${treeNodeMaximum}.`);
  }
  if (positionals[0] === "migrate") {
    const usage =
      "Usage: deps migrate --plan FILE [--repo owner/name] [--json] (read-only; automatic apply is deferred, #48)";
    if (positionals.length !== 1 || !values.plan || values.on || values.note || values.tree)
      throw new Error(usage);
    if (values["dry-run"]) throw new Error(`--plan never changes GitHub. ${usage}`);
    return { migrate: "plan", file: values.plan, repo: values.repo, json: values.json };
  }
  if (values.plan) throw new Error("--plan applies only to deps migrate.");
  if (positionals[0] === "add" || positionals[0] === "remove") {
    const usage = `Usage: deps ${positionals[0]} N --on M [--on K] --note WHY [--dry-run] [--json] [--repo owner/name]`;
    const target = number(positionals[1]);
    const parsed = (values.on ?? []).map(number);
    const on = parsed.filter((n): n is number => n !== null);
    if (
      positionals.length !== 2 ||
      !target ||
      !on.length ||
      on.length !== parsed.length ||
      values.tree
    )
      throw new Error(usage);
    if (!values.note?.trim()) throw new Error(`--note WHY is required. ${usage}`);
    return {
      action: positionals[0],
      number: target,
      on,
      note: values.note.trim(),
      dryRun: !!values["dry-run"],
      repo: values.repo,
      json: values.json,
    };
  }
  if (values.on || values.note || values["dry-run"])
    throw new Error("--on, --note and --dry-run apply only to deps add/remove.");
  if (values.top) {
    if (positionals.length || values.tree || values["max-nodes"])
      throw new Error("Usage: deps --top [--limit K] [--json] [--repo owner/name]");
    const limit = values.limit === undefined ? 10 : number(values.limit);
    if (limit === null || limit > 50) throw new Error("--limit must be 1–50.");
    return {
      top: true,
      limit,
      repo: values.repo,
      json: values.json,
      ...(values.agent ? { agent: values.agent } : {}),
      ...(values.platform ? { platform: values.platform } : {}),
    };
  }
  if (values.limit) throw new Error("--limit applies only to deps --top.");
  if (
    positionals.length !== 1 ||
    !/^[1-9]\d*$/.test(positionals[0]) ||
    !Number.isSafeInteger(Number(positionals[0]))
  )
    throw new Error("Usage: deps N [--tree [--max-nodes K]] [--json] [--repo owner/name]");
  const limit = values["max-nodes"];
  if (limit !== undefined) {
    if (!values.tree) throw new Error("--max-nodes applies only to deps N --tree.");
    const parsed = number(limit);
    if (parsed === null || parsed > treeNodeMaximum)
      throw new Error(`--max-nodes must be 1–${treeNodeMaximum}.`);
  }
  return {
    repo: values.repo,
    json: values.json,
    tree: values.tree,
    number: Number(positionals[0]),
    ...(limit !== undefined ? { maxNodes: Number(limit) } : {}),
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values.platform ? { platform: values.platform } : {}),
  };
}
/** Dry runs report the exit code the real run would give if every apply succeeded. */
const plannedExit = (changes: { status: string }[]): number => {
  const applying = changes.some((c) => c.status === "apply");
  const refused = changes.some((c) => c.status === "refused");
  return !applying ? (refused ? 1 : 0) : refused ? 2 : 0;
};
const releaseUsage =
  "Usage: pdb release N --agent NAME --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL] [--dry-run] [--json]";
export const releaseHelp = `${releaseUsage}
Hand over your active claim on issue N in one operation (doc/design/workflow.md, #62).
Re-reads live state, then: removes agent:NAME (only yours; other owners are kept), sets one
handoff readiness label, and posts a handoff comment with the outcome, note and deliverable.
  --as ready        Untouched: back to status:ready
  --as incomplete   Partly worked (parked is a synonym): status:incomplete, still pickable
  --as done         Your contribution is finished. With an open PR (--pr, or one linked to
                    the issue): status:awaiting-review, out of pickup. Without one: no
                    readiness label, reported for inspection. Never closes the issue or PR;
                    an unverifiable --pr is reported UNKNOWN, not guessed merged
  --note TEXT       What was done and what remains (expected; absence never blocks release)
  --pr URL          Preferred deliverable link; --change URL for a direct-main change set
Questions, blockers, attention:*, needs-design and parked/blocked labels are left untouched.
The handoff comment, recording the label plan, is posted before labels change; a retry
applies only that recorded plan and refuses if ownership or readiness changed since.
Each step is reported done/failed/skipped; a retry of the same command completes only the
missing steps and never duplicates the handoff comment. Changed live state is re-evaluated.
You choose the outcome; the tool never chooses one for you.
Exit: 0 done and verified; 2 partly done, conflict, or unverified (see Retry); 1 refused or nothing done.
`;
/**
 * Arguments for `claim`, `release` and `needs-human` (doc/design/workflow.md).
 */
export const questionUsage =
  "Usage: pdb question resolve|withdraw N --agent NAME --question URL --why TEXT [--dry-run] [--json] [--repo owner/name]";

/** Arguments of `question resolve|withdraw` (#412). */
export function questionArgumentsFor(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      question: { type: "string" },
      why: { type: "string" },
    },
  });
  const [op, issue] = positionals;
  if (
    positionals.length !== 2 ||
    (op !== "resolve" && op !== "withdraw") ||
    !/^[1-9]\d*$/.test(issue ?? "") ||
    !values.agent ||
    !/^[A-Za-z0-9][\w.-]*$/.test(values.agent) ||
    !values.question ||
    !values.why?.trim()
  )
    throw new Error(questionUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  return {
    op: op as "resolve" | "withdraw",
    number: Number(issue),
    agent: values.agent,
    question: values.question,
    why: values.why.trim(),
    repo: values.repo,
    json: values.json,
    dryRun: !!values["dry-run"],
  };
}

export function workflowArgumentsFor(command: "claim" | "needs-human" | "release", args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      branch: { type: "string" },
      platform: { type: "string" },
      rework: { type: "boolean" },
      designer: { type: "string" },
      why: { type: "string" },
      question: { type: "string", multiple: true },
      as: { type: "string" },
      note: { type: "string" },
      pr: { type: "string" },
      change: { type: "string" },
      release: { type: "boolean" },
    },
  });
  const usage =
    command === "claim"
      ? "Usage: pdb claim N --agent NAME [--branch BRANCH] [--platform P] [--rework] [--dry-run] [--json]"
      : command === "release"
        ? releaseUsage
        : "Usage: pdb needs-human N --agent NAME --designer NAME --why TEXT --question TEXT [--question TEXT...] [--release] [--dry-run] [--json]";
  const number =
    positionals.length === 1 && /^[1-9]\d*$/.test(positionals[0]) ? Number(positionals[0]) : null;
  const name = /^[A-Za-z0-9][\w.-]*$/;
  if (!number || !values.agent || !name.test(values.agent)) throw new Error(usage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const common = {
    number,
    agent: values.agent,
    repo: values.repo,
    json: values.json,
    dryRun: !!values["dry-run"],
  };
  const releaseOnly = values.as ?? values.note ?? values.pr ?? values.change;
  if (command === "release") {
    if (
      values.designer ||
      values.why ||
      values.question ||
      values.branch ||
      values.platform ||
      values.rework ||
      values.release
    )
      throw new Error(usage);
    const outcome = claimPolicy.outcomes.find((o) => o === values.as);
    if (!outcome)
      throw new Error(`--as must be one of ${claimPolicy.outcomes.join(", ")}.\n${usage}`);
    if (values.pr && values.change) throw new Error(`Use --pr or --change, not both.\n${usage}`);
    const pr = values.pr?.trim() || null;
    const change = values.change?.trim() || null;
    if (pr && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(pr))
      throw new Error("--pr must be a GitHub pull request URL.");
    if (change && !/^https?:\/\/\S+$/.test(change)) throw new Error("--change must be a URL.");
    const note = values.note?.trim() || null;
    if (note && note.length > claimPolicy.maxNote)
      throw new Error(`--note is limited to ${claimPolicy.maxNote} characters.`);
    return { ...common, outcome, note, pr, change };
  }
  if (releaseOnly !== undefined) throw new Error(usage);
  if (command === "claim") {
    if (values.designer || values.why || values.question || values.release) throw new Error(usage);
    return {
      ...common,
      branch: values.branch,
      platform: values.platform,
      rework: !!values.rework,
    };
  }
  const questions = (values.question ?? []).map((q) => q.trim()).filter(Boolean);
  if (!values.designer || !name.test(values.designer) || !values.why?.trim() || !questions.length)
    throw new Error(usage);
  if (values.branch || values.platform || values.rework) throw new Error(usage);
  return {
    ...common,
    designer: values.designer,
    why: values.why.trim(),
    questions,
    release: !!values.release,
  };
}

export const claimWaitUsage =
  "Usage: pdb claim wait N --agent NAME (--question URL | --blocked-by owner/name#M) --why TEXT [--dry-run] [--json] [--repo owner/name]\n       pdb claim resume N --agent NAME [--dry-run] [--json] [--repo owner/name]";

/** Arguments of `claim wait` and `claim resume` (#412). */
export function claimActivityArgumentsFor(op: "wait" | "resume", args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      question: { type: "string" },
      "blocked-by": { type: "string" },
      why: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !/^[1-9]\d*$/.test(positionals[0]!) ||
    !values.agent ||
    !/^[A-Za-z0-9][\w.-]*$/.test(values.agent)
  )
    throw new Error(claimWaitUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const common = {
    op,
    number: Number(positionals[0]),
    agent: values.agent,
    repo: values.repo,
    json: values.json,
    dryRun: !!values["dry-run"],
  };
  if (op === "resume") {
    if (values.question || values["blocked-by"] || values.why) throw new Error(claimWaitUsage);
    return common;
  }
  if (!values.why?.trim() || !values.question === !values["blocked-by"])
    throw new Error(claimWaitUsage);
  return {
    ...common,
    why: values.why.trim(),
    ...(values.question ? { question: values.question } : {}),
    ...(values["blocked-by"] ? { blockedBy: values["blocked-by"] } : {}),
  };
}
export function argumentsFor(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      full: { type: "boolean" },
      agent: { type: "string" },
      "max-chars": { type: "string" },
      issue: { type: "string" },
      since: { type: "string" },
      checkpoint: { type: "string" },
      cache: { type: "string" },
      offline: { type: "boolean" },
      "include-transferred": { type: "boolean" },
      limit: { type: "string" },
      order: { type: "string" },
      platform: { type: "string" },
      "stale-hours": { type: "string" },
      estimate: { type: "boolean" },
      role: { type: "string" },
      guide: { type: "boolean" },
      "no-guide": { type: "boolean" },
      context: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.guide && values["no-guide"])
    throw new Error("Use either --guide or --no-guide, not both.");
  if (values.role !== undefined && !briefingRoleNames().includes(values.role))
    throw new Error(`--role must be one of ${briefingRoleNames().join(", ")}.`);
  if (values.role !== undefined && values.full)
    throw new Error("--role shapes the compact briefing; it cannot be combined with --full.");
  if (values.role === "human" && (values.issue || values.estimate))
    throw new Error(
      "--role human is a repository view of human input; it cannot be combined with --issue or --estimate.",
    );
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const order = values.order ?? defaultPickupOrder;
  if (!isPickupOrder(order)) throw new Error(`--order must be one of ${pickupOrders.join(", ")}.`);
  if (values.platform !== undefined && !/^[\w.-]+$/.test(values.platform))
    throw new Error("--platform must be a platform name such as claude-code.");
  const staleHours =
    values["stale-hours"] === undefined ? undefined : Number(values["stale-hours"]);
  if (staleHours !== undefined && (!Number.isFinite(staleHours) || staleHours <= 0))
    throw new Error("--stale-hours must be a positive number.");
  const positive = (text: string, option: string): number => {
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
      throw new Error(`${option} must be a positive integer.`);
    return Number(text);
  };
  if (
    values.since &&
    (!/^\d{4}-\d\d-\d\dT/.test(values.since) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.since) ||
      !Number.isFinite(Date.parse(values.since)))
  )
    throw new Error("--since must be an ISO timestamp with a time.");
  if (values.offline && values.since)
    throw new Error("--since requires a live fetch; offline data cannot verify changes.");
  if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
  return {
    ...values,
    issue: values.issue ? positive(values.issue, "--issue") : undefined,
    limit: positive(values.limit ?? "10", "--limit"),
    maxChars: positive(values["max-chars"] ?? "10000", "--max-chars"),
    since: values.since ? new Date(values.since).toISOString() : undefined,
    order,
    staleHours,
    guide: values.guide ? true : values["no-guide"] ? false : undefined,
  };
}
const isPickupOrder = (text: string): text is PickupOrder =>
  (pickupOrders as readonly string[]).includes(text);
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Structural check of a cached snapshot. Only the envelope is validated (as before the
 * TypeScript migration); the guard is the single narrowly accepted trust point for cache files.
 */
function isSnapshotEnvelope(data: unknown, repository: string | undefined): data is Snapshot {
  return !(
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.repository !== "string" ||
    (repository && data.repository !== repository) ||
    !Number.isFinite(Date.parse(String(data.fetchedAt))) ||
    !Number.isFinite(Date.parse(String(data.startedAt))) ||
    ![data.issues, data.pullRequests, data.dependencies, data.changed, data.warnings].every(
      Array.isArray,
    )
  );
}
export async function cachedSnapshot(
  path: string,
  repository: string | undefined,
): Promise<Snapshot> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isSnapshotEnvelope(data, repository))
    throw new Error("Cache schema/repository is invalid or unsupported.");
  // A focused read (#367) holds one ticket, not the repository's open inventory.
  const profile = prop(data, "collection", "profile");
  if (profile !== undefined && profile !== "compatibility-full-v1")
    throw new Error(
      `Cache holds a focused ${typeof profile === "string" ? profile : "unknown"} read, not a repository snapshot.`,
    );
  return data;
}
export async function checkpointSince(
  path: string,
  repository: string,
): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(data) ||
      data.schemaVersion !== 1 ||
      data.repository !== repository ||
      typeof data.through !== "string" ||
      !Number.isFinite(Date.parse(data.through))
    )
      throw new Error("Checkpoint schema/repository is invalid.");
    return data.through;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
/** #192: per-run delivery boundaries; offline, or without injected ones, nothing is read. */
const deliveryBoundaries = (runtime: Runtime, repository: string, offline: boolean) =>
  !offline && runtime.rest && runtime.query
    ? {
        trust: markerTrust(permissionLookup(repository, runtime.rest)),
        trustWith: (rest: Rest) => markerTrust(permissionLookup(repository, rest)),
        live: { query: runtime.query, rest: runtime.rest },
      }
    : {};

export async function main(
  args: string[],
  output: Output = (text) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
    ),
  runtime: Runtime = { collect, currentRepository, dependencyReport, rest: ghRest, query: ghQuery },
): Promise<number> {
  // Version check (#51, cached daily per user by #65): runs alongside the command, bounded by a short timeout, and reports
  // only on stderr so JSON on stdout stays valid. --offline and opt-outs mean no network.
  const optOut =
    args.includes("--no-update-check") ||
    !!process.env[optOutEnv] ||
    !!process.env[legacyOptOutEnv];
  const rest = args.filter((a) => a !== "--no-update-check");
  const check = runtime.updateCheck ?? cachedCheckForUpdate;
  if (rest[0] === "version") {
    const installed = await installedVersion();
    const result = await check({ offline: rest.includes("--offline"), optOut, installed });
    await output(
      rest.includes("--json")
        ? JSON.stringify({ schemaVersion: 1, version: installed.version, check: result }, null, 2) +
            "\n"
        : `pdb ${installed.version ?? "(unknown version)"}\nUpdate check: ${result.status}${"reason" in result && result.reason ? ` — ${result.reason}` : ""}${"available" in result && result.available ? ` (npm ${result.channel}: ${result.available})` : ""}\n`,
    );
    return 0;
  }
  // Help is instant; it should not wait on the network, so it is not an eligible invocation.
  const eligible =
    !rest.includes("--help") &&
    !(rest[0] === "config" && rest[1] === "help") &&
    rest[0] !== "process" &&
    rest[0] !== "rules" &&
    // A foreground server prints its banner first and runs until stopped; no advisory.
    rest[0] !== "serve";
  const pending = eligible
    ? Promise.resolve()
        .then(() => check({ offline: rest.includes("--offline"), optOut }))
        .catch(() => null)
    : Promise.resolve(null);
  try {
    return await run(rest, output, runtime);
  } finally {
    const advisory = updateAdvisory(
      (await pending) ?? { status: "unknown", reason: "", installed: null, channel: "" },
    );
    if (advisory) (runtime.stderr ?? ((t) => process.stderr.write(t)))(`${advisory}\n`);
  }
}

/**
 * `pdb rules` (#416): the compiled policy. Local and credential-free: it reads only the bundled
 * artifact. The document is built and validated before anything is printed, so a failure never
 * leaves a partial listing on stdout. Exit 2 for arguments, 1 for a missing or stale artifact.
 */
async function runRules(args: string[], output: Output, runtime: Runtime): Promise<number> {
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  let values: { json?: boolean; rule?: string; role?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        json: { type: "boolean" },
        rule: { type: "string" },
        role: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    stderr(
      `pdb rules: ${error instanceof Error ? error.message : String(error)}\nRun pdb rules --help.\n`,
    );
    return 2;
  }
  const rules = await import("./rules/datalog/datalog.js");
  if (values.help) {
    await output(rules.rulesHelp);
    return 0;
  }
  let text: string;
  try {
    const document = rules.rulesDocument(declaredRulesContext(), {
      rule: values.rule,
      role: values.role,
    });
    text = values.json ? `${JSON.stringify(document, null, 2)}\n` : rules.rulesText(document);
  } catch (error) {
    stderr(`pdb rules: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof rules.RulesArgumentError ? 2 : 1;
  }
  await output(text);
  return 0;
}

/** `pdb issue create` (#199, doc/design/issue-creation.md). */
async function runIssue(args: string[], output: Output, runtime: Runtime): Promise<number> {
  if (args[0] !== "create") throw new Error(issueCreateUsage);
  const rest = args.slice(1);
  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) {
    await output(issueCreateHelp);
    return 0;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        title: { type: "string" },
        body: { type: "string" },
        "body-file": { type: "string" },
        label: { type: "string", multiple: true },
        repo: { type: "string" },
        agent: { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
      },
    }));
  } catch {
    throw new Error(issueCreateUsage);
  }
  if (values.title === undefined) throw new Error(`--title is required. ${issueCreateUsage}`);
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  const rt: IssueCreateRuntime = {
    rest: runtime.rest ?? ghRest,
    post: ghPost,
    currentRepository: () => runtime.currentRepository(),
    now: runtime.now ?? (() => new Date()),
    operationId: defaultOperationId,
    readFile: defaultReadFile,
    readStdin: readStdinBounded,
    stderr,
    ...runtime.issueCreate,
  };
  let result;
  try {
    result = await createIssue(
      {
        title: values.title,
        ...(values.body !== undefined ? { body: values.body } : {}),
        ...(values["body-file"] !== undefined ? { bodyFile: values["body-file"] } : {}),
        labels: values.label ?? [],
        ...(values.repo !== undefined ? { repo: values.repo } : {}),
        ...(values.agent !== undefined ? { agent: values.agent } : {}),
        dryRun: !!values["dry-run"],
        json: !!values.json,
      },
      rt,
    );
  } catch (error) {
    if (error instanceof IssueCreateUsageError) throw new Error(error.message);
    throw error;
  }
  await output(values.json ? JSON.stringify(result, null, 2) + "\n" : issueCreateText(result));
  return issueCreateExitCode(result);
}

/** The command itself; `main` adds the version check around it. */
async function run(args: string[], output: Output, runtime: Runtime): Promise<number> {
  if (args[0] === "rules") return runRules(args.slice(1), output, runtime);
  if (args[0] === "process") {
    const { values } = parseArgs({ args: args.slice(1), options: { json: { type: "boolean" } } });
    await output(values.json ? JSON.stringify(fullGuideJson(), null, 2) + "\n" : fullGuideText());
    return 0;
  }
  if (args[0] === "briefing")
    return runBriefing(args.slice(1), output, {
      ...runtime,
      files: runtime.briefingFiles ?? { atomicJson, cachedSnapshot, checkpointSince },
    });
  if (args[0] === "serve") return runServe(args.slice(1), runtime.serve);
  if (args[0] === "issue") return runIssue(args.slice(1), output, runtime);
  if (args[0] === "quotas")
    return runQuotas(args.slice(1), output, {
      rest: runtime.rest ?? ghRest,
      authContext: ghAuthContext,
      host: () => process.env.GH_HOST?.trim() || "github.com",
      now: runtime.now,
      ...runtime.quotas,
    });
  if (args[0] === "config") return runConfig(args.slice(1), output, runtime.config);
  if (args[0] === "doctor") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        agent: { type: "string" },
        role: { type: "string" },
        entry: { type: "string" },
        harness: { type: "string" },
      },
    });
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    if (values.entry !== undefined && values.harness !== undefined)
      throw new Error("Pass either --entry or --harness, not both.");
    const report = await localDoctor(
      {
        repo: values.repo,
        agent: values.agent,
        role: values.role,
        entry: values.entry,
        harness: values.harness,
      },
      runtime.localDoctor,
    );
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : localDoctorText(report));
    return localDoctorExitCode(report);
  }
  if (args[0] === "ticket-doctor") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        limit: { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
        since: { type: "string" },
      },
    });
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? doctorStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    const limit = values.limit === undefined ? 30 : Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0)
      throw new Error("--limit must be a positive integer.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    // #192: closed-issue drift reads an explicit bounded window live; never from a cache.
    if (values.since !== undefined && (values.offline || Number.isNaN(Date.parse(values.since))))
      throw new Error(
        values.offline
          ? "--since reads closed issues live and cannot be used with --offline."
          : "--since must be an ISO 8601 timestamp.",
      );
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {});
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const impact = await metricStatus(impactMetric, snapshot.repository, runtime.estimation).catch(
      () => "unknown" as const,
    );
    // #192: delivery records are folded with the per-run permission cache and evaluated live;
    // offline (or without a permission boundary) they are reported unknown, never absent.
    const rest = values.offline ? undefined : runtime.rest;
    const delivery = await diagnoseDelivery(snapshot, {
      trust: rest ? markerTrust(permissionLookup(snapshot.repository, rest)) : undefined,
      live: rest ? { query: runtime.query ?? ghQuery, rest } : undefined,
    });
    const closedDrift =
      values.since !== undefined && rest
        ? await diagnoseClosedDrift(snapshot.repository, new Date(values.since).toISOString(), {
            trust: markerTrust(permissionLookup(snapshot.repository, rest)),
            live: { query: runtime.query ?? ghQuery, rest },
          })
        : undefined;
    const report = ticketDoctor(snapshot, {
      delivery,
      closedDrift,
      staleHours,
      limit,
      now: runtime.now?.() ?? new Date(),
      offline: !!values.offline,
      impactEnabled: impact !== "disabled",
    });
    // #192: the same delivery block as the briefing, for tickets with delivery evidence.
    const read = deliveryRead(snapshot, delivery);
    // Per-ticket coverage gaps join the scan's completeness, as on every read surface.
    const coverage = read.omissions.filter((o) => !delivery.warnings.includes(o));
    const doctor = withDeliveryCompleteness(report, {
      complete: !coverage.length,
      omissions: coverage,
    });
    const json = read.tickets.length ? { ...doctor, delivery: read } : doctor;
    await output(values.json ? JSON.stringify(json, null, 2) + "\n" : ticketDoctorText(doctor));
    return doctor.completeness.complete ? 0 : 2;
  }
  if (args[0] === "submit" || args[0] === "deliverables") {
    const submit = args[0] === "submit";
    if (args.length === 1 || args.slice(1).some((a) => a === "--help" || a === "-h")) {
      await output(submit ? submitHelp : deliverablesHelp);
      return 0;
    }
    const { request, repo, json, dryRun } = submit
      ? submitArguments(args.slice(1))
      : deliverablesArguments(args.slice(1));
    const repository = repo ?? (await runtime.currentRepository());
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = permissionLookup(repository, runtime.rest ?? ghRest);
    const rt = {
      query: runtime.query ?? ghQuery,
      run: runtime.ghRun ?? ghRun,
      rest: runtime.rest ?? ghRest,
      trust: markerTrust(permission),
      now: runtime.now ?? (() => new Date()),
    };
    const plan = await planDeliverables(repository, request, rt);
    const result =
      dryRun || !plan.ok || plan.noop
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyDeliverables(repository, request, rt, plan);
    await output(
      json
        ? JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n"
        : deliverablesText(result, dryRun),
    );
    return result.exitCode;
  }
  if (args[0] === "complete") {
    if (args.length === 1 || args.slice(1).some((a) => a === "--help" || a === "-h")) {
      await output(completeHelp);
      return 0;
    }
    const { request, repo, json, dryRun } = completeArguments(args.slice(1));
    const repository = repo ?? (await runtime.currentRepository());
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = permissionLookup(repository, runtime.rest ?? ghRest);
    const rt = {
      query: runtime.query ?? ghQuery,
      run: runtime.ghRun ?? ghRun,
      rest: runtime.rest ?? ghRest,
      trust: markerTrust(permission),
      now: runtime.now ?? (() => new Date()),
    };
    const plan = await planComplete(repository, request, rt);
    const result =
      dryRun || !plan.ok || plan.noop
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyComplete(repository, request, rt, plan);
    await output(
      json
        ? JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n"
        : completeText(result, dryRun),
    );
    return result.exitCode;
  }
  if (args[0] === "release" && (args[1] === "--help" || args[1] === "-h")) {
    await output(releaseHelp);
    return 0;
  }
  if (args[0] === "question") {
    const values = questionArgumentsFor(args.slice(1));
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const permission = permissionLookup(repository, runtime.rest ?? ghRest);
    // Read live immediately before writing; never act on a cached snapshot.
    const plan = await planQuestionResolution(repository, values, query, permission);
    const result =
      values.dryRun || !plan.ok || plan.noop
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyPlan(repository, plan, { run: runtime.ghRun ?? ghRun, query });
    await output(
      values.json
        ? JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n"
        : claimText(result, values.dryRun),
    );
    return result.exitCode;
  }
  if (args[0] === "claim" && (args[1] === "wait" || args[1] === "resume")) {
    const values = claimActivityArgumentsFor(args[1], args.slice(2));
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const permission = permissionLookup(repository, runtime.rest ?? ghRest);
    // Read live immediately before writing; never act on a cached snapshot.
    const plan =
      "why" in values
        ? await planClaimWait(repository, values, query, permission)
        : await planClaimResume(
            repository,
            values,
            query,
            permission,
            admissionFor(repository, values.agent, query, permission),
          );
    let result =
      values.dryRun || !plan.ok || plan.noop
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyPlan(repository, plan, { run: runtime.ghRun ?? ghRun, query });
    // A written record is not a transition until the fold accepts it.
    if (result.ok && result.exitCode === 0 && !values.dryRun && plan.ok && plan.activityOpId) {
      const conflict = await verifyTransition(
        repository,
        values.number,
        values.agent,
        plan.activityOpId,
        query,
        permission,
      );
      if (conflict) result = { ...result, conflict, exitCode: 2 } as typeof result;
    }
    await output(
      values.json
        ? JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n"
        : claimText(result, values.dryRun),
    );
    return result.exitCode;
  }
  if (args[0] === "claim" || args[0] === "needs-human" || args[0] === "release") {
    const values = workflowArgumentsFor(args[0], args.slice(1));
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = permissionLookup(repository, runtime.rest ?? ghRest);
    const rt = {
      query,
      run: runtime.ghRun ?? ghRun,
      rest: runtime.rest ?? ghRest,
      trust: markerTrust(permission),
      now: runtime.now ?? (() => new Date()),
    };
    // Read live immediately before changing; never act on a cached snapshot.
    const plan =
      "questions" in values
        ? await planNeedsHuman(repository, values, query, permission)
        : "outcome" in values
          ? await planRelease(repository, values, query, permission)
          : await planClaim(
              repository,
              values,
              query,
              permission,
              values.rework
                ? () => reworkAuthority(repository, values.number, values.agent, rt)
                : undefined,
              admissionFor(repository, values.agent, query, permission),
            );
    const stillWaiting = stillWaitingFor(repository, values.agent, query, permission);
    // needs-human on a claim the caller keeps (#412): question first, then the wait bound to
    // it, then labels, so the wait never precedes a durable question and labels never claim
    // a wait that was not recorded.
    if ("questions" in values && plan.ok && plan.retainsClaim && !values.dryRun) {
      const run = runtime.ghRun ?? ghRun;
      const asked = await applyPlan(
        repository,
        { ...plan, changes: plan.changes.filter((c) => c.step === "comment"), recheck: undefined },
        { run, query },
      );
      let wait: (ClaimPlan & { exitCode: number }) | ClaimResult | null = null;
      let waitNote = "Question not saved; no wait recorded and no labels changed.";
      let waitOk = false;
      if (asked.exitCode === 0) {
        const waitPlan = await planWaitOnQuestion(
          repository,
          {
            number: values.number,
            agent: values.agent,
            questionOpId: plan.questionOpId!,
            why: values.why,
          },
          query,
          permission,
        );
        if (!waitPlan.ok) {
          // A claim already waiting on another blocker keeps that wait; the labels still apply.
          waitOk = waitPlan.error === "ALREADY_WAITING";
          waitNote = waitOk
            ? `Claim kept; ${waitPlan.prerequisite}`
            : `Question saved, but the wait was not recorded (${waitPlan.error}: ${waitPlan.prerequisite}); labels not changed. Re-run the same command.`;
          wait = { ...waitPlan, exitCode: waitOk ? 0 : 2 };
        } else {
          const applied = waitPlan.noop
            ? { ...waitPlan, exitCode: 0 }
            : await applyPlan(repository, waitPlan, { run, query });
          const stale =
            applied.exitCode === 0 && !waitPlan.noop && waitPlan.activityOpId
              ? await verifyTransition(
                  repository,
                  values.number,
                  values.agent,
                  waitPlan.activityOpId,
                  query,
                  permission,
                )
              : null;
          if (stale) applied.exitCode = 2;
          waitOk = applied.exitCode === 0;
          waitNote = waitOk
            ? (waitPlan.reason ?? "Wait recorded.")
            : "Question saved, but the wait could not be written; labels not changed. Re-run the same command.";
          wait = { ...applied, exitCode: waitOk ? 0 : 2 };
        }
      }
      const labelled =
        asked.exitCode === 0 && waitOk
          ? await applyPlan(
              repository,
              { ...plan, changes: plan.changes.filter((c) => c.step !== "comment") },
              { run, query },
            )
          : null;
      const exitCode = Math.max(asked.exitCode, wait?.exitCode ?? 0, labelled?.exitCode ?? 0);
      const combined: ClaimResult = {
        ...(labelled ?? asked),
        steps: [...(asked.steps ?? []), ...(labelled?.steps ?? [])],
        notes: [...(plan.notes ?? []), waitNote],
        exitCode,
      } as ClaimResult;
      await output(
        values.json
          ? JSON.stringify({ schemaVersion: 1, ...combined, wait }, null, 2) + "\n"
          : claimText(combined, false),
      );
      return exitCode;
    }
    const result =
      values.dryRun || !plan.ok
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyPlan(repository, plan, {
            run: runtime.ghRun ?? ghRun,
            query,
            stillWaiting,
          });
    // Rework on the delivery-record path: after the claim, one `membership open` record
    // (doc "Rework authority"). A legacy rework writes nothing more; a failed or conflicting
    // claim writes nothing more. A retry of the same claim completes a missing record.
    const membership =
      "rework" in values && values.rework && !values.dryRun && plan.ok && result.exitCode === 0
        ? await applyDeliverables(
            repository,
            reworkMembershipRequest(values.number, values.agent),
            rt,
          )
        : null;
    const exitCode = membership && membership.exitCode !== 0 ? 2 : result.exitCode;
    await output(
      values.json
        ? JSON.stringify(
            {
              schemaVersion: 1,
              ...result,
              ...(membership ? { reworkMembership: membership, exitCode } : {}),
            },
            null,
            2,
          ) + "\n"
        : claimText(result, values.dryRun) + (membership ? deliverablesText(membership) : ""),
    );
    return exitCode;
  }
  if (args[0] === "team") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? defaultStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {});
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const { report, text } = await readTeam(
      snapshot,
      { staleHours, now: runtime.now?.() ?? new Date(), offline: !!values.offline },
      deliveryBoundaries(runtime, snapshot.repository, !!values.offline),
    );
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : text);
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "ticket") {
    const parsed = ticketArgumentsFor(args.slice(1));
    if (parsed.help) {
      await output(ticketHelp);
      return 0;
    }
    const { values, positionals, limitPrs, maxChars } = parsed;
    const number = Number(positionals[0]);
    const repository = values.repo ?? (await runtime.currentRepository());
    let read;
    try {
      read = await readTicketStatus(
        repository,
        number,
        {
          staleHours: defaultStaleHours,
          now: runtime.now?.() ?? new Date(),
          limitPrs,
          ...(values.agent ? { agent: values.agent } : {}),
          ...(values.platform ? { platform: values.platform } : {}),
        },
        deliveryBoundaries(runtime, repository, false),
        runtime.query ?? ghQuery,
        runtime.now,
        runtime.collectIssueFocus,
      );
    } catch (error) {
      if (!(error instanceof IssueUnavailable)) throw error;
      // The existing missing/forbidden/moved diagnosis; a transfer is never followed here.
      const d = error.diagnosis;
      const report = { schemaVersion: 1, kind: "issue-unavailable", ...d };
      await output(values.json ? JSON.stringify(report, null, 2) + "\n" : unavailableText(d));
      return 1;
    }
    await output(
      values.json
        ? JSON.stringify(read.report, null, 2) + "\n"
        : ticketStatusText(read.report, maxChars),
    );
    return read.complete ? 0 : 2;
  }
  if (args[0] === "who") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw new Error("Usage: pdb who N [--json] [--stale-hours N] [--repo owner/name]");
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? defaultStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    const number = Number(positionals[0]);
    if (!values.offline && !values.cache) {
      // issue-detail-v1 (#367): the ticket and its linked open PRs only, never the repository.
      const repository = values.repo ?? (await runtime.currentRepository());
      const { report, text } = await readWhoLive(
        repository,
        number,
        { staleHours, now: runtime.now?.() ?? new Date() },
        deliveryBoundaries(runtime, repository, false),
        runtime.query ?? ghQuery,
        runtime.now,
        runtime.collectIssueFocus,
      );
      await output(values.json ? JSON.stringify(report, null, 2) + "\n" : text);
      return report.completeness.complete ? 0 : 2;
    }
    // A cache is written or read: keep the full compatibility snapshot, which a later offline
    // briefing may read as a repository inventory. A focused read is never cached as one.
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {
          issue: number,
        });
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const { report, text } = await readWho(
      snapshot,
      number,
      { staleHours, now: runtime.now?.() ?? new Date(), offline: !!values.offline },
      deliveryBoundaries(runtime, snapshot.repository, !!values.offline),
    );
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : text);
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "estimate") {
    const rest = args.slice(1);
    if (rest.includes("--help")) {
      // #246: --metric impact selects the bundled impact guidance; the default is unchanged.
      const metricAt = rest.indexOf("--metric");
      const metric = metricAt === -1 ? "complexity" : rest[metricAt + 1];
      const known = rest.filter(
        (a, i) => a === "--help" || a === "--json" || i === metricAt || i === metricAt + 1,
      );
      if (
        known.length !== rest.length ||
        rest.filter((a) => a === "--metric").length > 1 ||
        (metric !== "complexity" && metric !== "impact")
      )
        throw new Error("Usage: pdb estimate --help [--metric complexity|impact] [--json]");
      const impact = metric === "impact";
      await output(
        rest.includes("--json")
          ? impact
            ? impactGuidanceJson()
            : complexityGuidanceJson()
          : `${estimateUsage}\n\n${impact ? impactGuidanceText() : complexityGuidanceText()}`,
      );
      return 0;
    }
    return runEstimate(rest, output, {
      now: runtime.now,
      // #245/#269: provenance authority for both metrics, the #212 rule over a per-run permission cache.
      trust: (repository) => markerTrust(permissionLookup(repository, runtime.rest ?? ghRest)),
      ...runtime.estimate,
    });
  }
  if (args[0] === "pr") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        history: { type: "boolean" },
      },
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw new Error("Usage: pdb pr N [--history] [--json] [--repo owner/name]");
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const { report, text } = values.history
      ? await readReviewHistory(repository, Number(positionals[0]), query)
      : await readPullRequest(
          repository,
          Number(positionals[0]),
          query,
          // #192: delivery and responsibility for the issues this PR is linked to close.
          deliveryBoundaries(runtime, repository, false),
          undefined,
          // #301: the repository's declared review policy, from local configuration only.
          await resolveReviewPolicy(repository, runtime.guide ?? {}),
        );
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : text);
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "deps") {
    const values = depsArgumentsFor(args.slice(1));
    if (values.help) {
      await output(depsHelp);
      return 0;
    }
    const repository = values.repo ?? (await runtime.currentRepository());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("--repo must be owner/name.");
    if ("migrate" in values) {
      const plan = await (runtime.planMigration ?? planMigration)(
        repository,
        runtime.migrationRuntime,
      );
      await atomicJson(values.file, plan);
      await output(values.json ? JSON.stringify(plan, null, 2) + "\n" : migrationPlanText(plan));
      return 0;
    }
    if ("top" in values) {
      const inventory = await (runtime.dependencyInventory ?? readDependencyInventory)(repository);
      const ranked = repositoryImpact(
        inventory,
        values.limit,
        { prs: [], ...(values.platform ? { platform: values.platform } : {}) },
        values.agent,
      );
      await output(
        values.json ? JSON.stringify(ranked, null, 2) + "\n" : repositoryImpactText(ranked),
      );
      return ranked.provisional ? 2 : 0;
    }
    if ("action" in values) {
      // Read live immediately before changing; never act on a cached snapshot.
      const plan = await (runtime.planDependencyChange ?? planDependencyChange)(repository, {
        action: values.action,
        number: values.number,
        on: values.on,
        note: values.note,
      });
      const result = values.dryRun
        ? {
            ...plan,
            dryRun: true,
            exitCode: plannedExit(plan.changes),
          }
        : await applyDependencyChange(plan, runtime.ghRun ?? ghRun);
      await output(
        values.json ? JSON.stringify(result, null, 2) + "\n" : dependencyChangeText(result),
      );
      return result.exitCode;
    }
    const report = await (runtime.dependencyReport ?? dependencyReport)(repository, values.number, {
      tree: !!values.tree,
      ...(values.maxNodes ? { maxNodes: values.maxNodes } : {}),
      // Routine reads answer the direct-impact question; --tree stays a diagnosis (#196).
      ...(values.tree ? {} : { impact: true }),
    });
    const impact = directImpact(
      report,
      { prs: [], ...(values.platform ? { platform: values.platform } : {}) },
      values.agent,
    );
    await output(
      values.json
        ? JSON.stringify(impact ? { ...report, impact } : report, null, 2) + "\n"
        : dependencyText(report) +
            directImpactText(impact)
              .map((line) => `${line}\n`)
              .join(""),
    );
    return dependencyReportIncomplete(report) ? 2 : 0;
  }
  const options = argumentsFor(args);
  if (options.help) {
    await output(help);
    return 0;
  }
  let snapshot: Snapshot;
  if (options.offline) snapshot = await cachedSnapshot(options.cache ?? "", options.repo);
  else {
    const repository = options.repo ?? (await runtime.currentRepository());
    const previous = options.checkpoint
      ? await checkpointSince(options.checkpoint, repository)
      : undefined;
    try {
      snapshot = await runtime.collect(repository, {
        issue: options.issue,
        since: options.since ?? previous,
      });
    } catch (error) {
      if (!(error instanceof IssueUnavailable)) throw error;
      const d = error.diagnosis;
      // Transferred-out work is excluded by default; only an explicit opt-in follows it.
      if (d.state === "moved" && options["include-transferred"]) {
        const rest = args.filter(
          (a, i) =>
            !["--repo", "--issue", "--cache", "--checkpoint"].includes(a) &&
            !["--repo", "--issue", "--cache", "--checkpoint"].includes(args[i - 1] ?? "") &&
            !/^--(repo|issue|cache|checkpoint)=/.test(a),
        );
        // Keep the origin identity visible: JSON gains transferredFrom, text a leading notice.
        const followed = async (text: string) =>
          output(
            options.json
              ? JSON.stringify({ ...JSON.parse(text), transferredFrom: d }, null, 2) + "\n"
              : `Followed transfer: ${d.url} -> ${String(d.destination.url)} (--include-transferred)\n${text}`,
          );
        return run(
          [...rest, "--repo", d.destination.repository, "--issue", String(d.destination.number)],
          followed,
          runtime,
        );
      }
      const report = { schemaVersion: 1, kind: "issue-unavailable", ...d };
      await output(options.json ? JSON.stringify(report, null, 2) + "\n" : unavailableText(d));
      return 2;
    }
    // An incomplete history read never replaces the last successful explicit snapshot.
    if (options.cache && historyComplete(snapshot)) await atomicJson(options.cache, snapshot);
    else if (options.cache)
      snapshot = {
        ...snapshot,
        warnings: [
          ...snapshot.warnings,
          `${options.cache} was not overwritten: this read's history window is incomplete.`,
        ],
      };
  }
  if (options.issue && !snapshot.issues.some((issue) => issue.number === options.issue))
    throw new Error(`Issue #${options.issue} not in this cache. Refresh live with --issue.`);
  const guideProcess = options.full
    ? undefined
    : briefingProcess(await resolveGuideSetting(snapshot.repository, options.guide, runtime.guide));
  const { report, text } = await presentBriefing(
    snapshot,
    {
      ...options,
      process: guideProcess,
      engineSetting:
        options.full || options.issue
          ? undefined
          : await resolveEngineSetting(snapshot.repository, runtime.guide ?? {}),
      // #301: declared review policy from local configuration (legacy when undeclared).
      reviewPolicy: await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {}),
    },
    runtime.estimation,
    runtime.now?.(),
    undefined,
    // Provenance authority (#247) uses the per-run permission cache; offline reads make no
    // request, so trusted provenance is then unknown. Without an injected boundary, likewise.
    !options.offline && runtime.rest
      ? markerTrust(permissionLookup(snapshot.repository, runtime.rest))
      : undefined,
    undefined,
    undefined,
    // #192: delivery evidence is read live only on a live read with both boundaries.
    !options.offline && runtime.rest && runtime.query
      ? {
          query: runtime.query,
          rest: runtime.rest,
          trustWith: (rest: Rest) => markerTrust(permissionLookup(snapshot.repository, rest)),
        }
      : undefined,
  );
  const checkpoint = options.checkpoint
    ? {
        previousWindow: snapshot.since,
        establishesBaseline: !snapshot.since,
        nextThroughCandidate:
          !options.offline && report.completeness.complete ? snapshot.startedAt : null,
        policy:
          "Advance only after complete successful live output; offline/incomplete results never advance.",
      }
    : null;
  const checkpointText = checkpoint
    ? `Checkpoint: ${checkpoint.establishesBaseline ? "establishing current baseline" : `previous window ${checkpoint.previousWindow}`}; ${checkpoint.policy}\n`
    : "";
  await output(
    options.json
      ? JSON.stringify({ ...report, checkpoint }, null, 2) + "\n"
      : text + checkpointText,
  );
  if (!options.offline && options.checkpoint && report.completeness.complete)
    // Start time deliberately overlaps windows: updates arriving during collection are not lost.
    await atomicJson(options.checkpoint, {
      schemaVersion: 1,
      repository: snapshot.repository,
      through: snapshot.startedAt,
    });
  return report.completeness.complete ? 0 : 2;
}
/**
 * True when this module is the process entry point. npm installs bins as
 * symlinks (or shims), so compare real paths rather than the raw argv path.
 */
function isEntryPoint(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`pdb: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
