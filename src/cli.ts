#!/usr/bin/env node
import {
  CommandIdentity,
  commandActor,
  commandViewer,
  prepareCommandIdentity,
  identitySelection,
  identitySelectionOptions,
  IdentityPreparationRequired,
  type PrepareCommandIdentity,
} from "./config/commandidentity.js";
import type { EffectiveIdentity } from "./config/effectiveidentity.js";
import { runRebrief } from "./rebrief/cli.js";
import type { CliRuntime as RebriefRuntime } from "./rebrief/cli.js";
import { resolveEngineSetting } from "./config/engine-setting.js";
import { resolveReviewPolicy } from "./config/review-setting.js";
import { resolveProjectRulesSetting } from "./config/project-rules-setting.js";
import { projectRulesContext } from "./rules/project-context.js";
/** One read-only intake command. Contract: doc/pdb-cli.md. */
import { realpathSync } from "node:fs";
import { crashDisclosure } from "./telemetry/crash-setting.js";
import { initializeCrashes } from "./telemetry/crashes.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  collect,
  currentRepository,
  collectIssueFocus,
  ghQuery,
  ghQueryWith,
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
import { briefingRoleNames, roleSectionIds } from "./briefing/roles.js";
import { labelsFromSnapshot, normalizeLabelRequest } from "./github/labels.js";
import { doctorStaleHours } from "./workflow/ticketdoctor.js";
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
import {
  checkoutAdvisory,
  checkoutFreshness,
  checkoutOptOutEnv,
  describeCheckout,
} from "./updates/checkout.js";
import { installedVersion, optOutEnv, legacyOptOutEnv, updateAdvisory } from "./updates/updates.js";
import { defaultStaleHours } from "./workflow/team.js";
import { migrationPlanText, planMigration } from "./github/migration.js";
import {
  humanRole,
  presentBriefing,
  resolveLabelFilter,
  shortlistLine,
  shownSubjects,
  unavailableText,
  withShortlist,
} from "./briefing/service.js";
import { collectShortlist } from "./github/shortlist.js";
import { ReadMeter } from "./github/readplan.js";
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
import { runConfig, runSetup } from "./config/configcli.js";
import { runContributors } from "./config/contributors.js";
import { quotaRefusal } from "./github/readplan.js";
import {
  humanContextEnabled,
  resolveHumanContext,
  type HumanContext,
} from "./config/humancontext.js";
import { STALE_WINDOW_MS } from "./serve/options.js";
import {
  ConfigError,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
} from "./config/config.js";
import {
  firstUseHint,
  firstUseHintOptOutEnv,
  firstUseHintText,
  runOnboard,
} from "./briefing/onboardcli.js";
import { advanceCheckpoint, overwriteJson, writeSnapshotCache } from "./config/safejson.js";
import type { WriteOutcome } from "./config/safejson.js";
import type { ConfigRuntime } from "./config/configcli.js";
import { installArgumentsFor, installHelp, runCodexInstallSurface } from "./install/codexcli.js";
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
  readTicketDoctor,
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
import { createGhService } from "./github/service/service.js";
import { runQuotas } from "./github/quotascli.js";
import type { QuotasRuntime } from "./github/quotascli.js";
import { ghPost } from "./github/service/issues.js";
import { ghService } from "./github/service/service.js";
import {
  createIssue,
  defaultOperationId,
  defaultReadFile,
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
export type DepsArguments = (
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
    }
) & { entry?: string; harness?: string; role?: string };

/** Injected services for `main`; tests replace the GitHub-facing ones. */
export interface Runtime {
  /** Normal CLI identity preparation; tests inject every local/session/human boundary. */
  prepareIdentity?: PrepareCommandIdentity;
  collect: typeof collect;
  /** Routine shortlist collection (#368); absent: the routine briefing reads the full snapshot. */
  collectShortlist?: typeof collectShortlist;
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
  /** Monotonic engine-budget clock; parity tests inject a fixed one. */
  engineClock?: () => number;
  updateCheck?: typeof cachedCheckForUpdate;
  /** Local-Git freshness of a source checkout (#309). */
  checkoutCheck?: typeof checkoutFreshness;
  /** #664: the employing human for a briefing; absent: not resolved (no \`human\` field). */
  briefingHuman?: (offline: boolean) => Promise<HumanContext>;
  /** First-use onboarding hint store (#351); tests inject it so no real cache is touched. */
  firstUseHint?: (project: string, version: string) => Promise<boolean>;
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
  rebrief?: RebriefRuntime;
}

type Output = (text: string) => Promise<void>;

export const help = `Usage: pdb [options]
       (from a source checkout: npm run pdb -- [options])
Presidential Daily Briefing: evidence-linked actions for coding agents. Requires authenticated gh and Node 26+.
Next-action default: Datalog, implementer view; --role designer selects design work.
Normal CLI first use: pass --role implementer|designer to safely initialize a missing local
identity and continue. Configured sessions reuse it. --entry/--harness select local identity;
explicit reads and dry-runs do not initialize. JSON adds effectiveIdentity; diagnostics use stderr.
Rollback: pdb config set briefing.engine typescript.
${crashDisclosure()}
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
                        codex-or-coderabbit / codex-or-copilot either provider's current-head acceptance
                        covers review; a finding from either still blocks
  pr N --history        Why does PR N keep failing review? Rounds, findings, recurring files
  claim N [--agent NAME] [--branch B] [--platform P] [--rework] [--dry-run]  Claim an eligible ticket;
                        --rework reclaims your own awaiting-review issue to fix review feedback;
                        with delivery records only the ticket-responsible agent may, and the
                        claim is followed by a membership-open record (finish with submit)
  release N [--agent NAME] --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL]
                        [--dry-run]  Hand over your claim in one operation: record the outcome,
                        release agent:NAME and set readiness (ready; incomplete=parked, still
                        pickable; done+open PR -> status:awaiting-review; done without one ->
                        no readiness, for inspection). Never closes; retry is safe (release --help)
  deliverables N attach|detach|retarget|handoff|membership|attest|reassign|reset|void
                        --agent NAME ... [--dry-run]  Record required deliverables and
                        responsibility on the issue (deliverables --help)
  submit N [--agent NAME] [--pr URL...] [--target owner/name:branch] [--membership open] [--dry-run]
                        Hand over your PRs: record them, release your claim and set
                        status:awaiting-review; you stay responsible for follow-up (submit --help)
  complete N [--agent NAME] [--dry-run]  Verify delivery from fresh evidence (every required PR
                        merged into its live target) and only then record completion and close
                        the issue as completed; never reopens or merges (complete --help)
  claim wait N [--agent NAME] (--question URL | --blocked-by owner/name#M) --why TEXT [--dry-run]
                        Keep your claim while it waits on a question or an open native blocker;
                        while every other claim of yours verifiably waits, you may claim one more
  claim resume N [--agent NAME] [--dry-run]  Make a waiting claim active again once its blocker
                        cleared (never automatic; refused while another claim is active)
  needs-human N [--agent NAME] --designer NAME --why TEXT --question TEXT... [--release] [--dry-run]
                        Record questions for a designer and mark the ticket decision-needed;
                        keeps your claim waiting on the question (--release relinquishes it)
  question resolve|withdraw N [--agent NAME] --question URL --why TEXT [--dry-run]
                        Record that a needs-human question was answered or withdrawn (explicit,
                        with a reason; never inferred from replies, labels or closure)
  quotas [--json] [--refresh | --offline]  Read-only GitHub API allowance per resource for
                        the gh login: one /rate_limit read, no repository scan; secondary
                        limits are unmetered (quotas --help)
  rebrief init|check|ack --json  Shared bounded continuation core (rebrief --help); no hook installed
  rebrief codex-stop     Experimental native stdin/JSON adapter (rebrief codex-stop --help)
  serve [--repo owner/name | --project PATH]... [--port N]  Foreground local HTTP server:
                        read-only JSON API and HTTP MCP over a short-lived memory cache; without
                        targets, saved registrations and this checkout are served (serve --help)
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
  setup identity --role implementer|designer [--entry KEY | --harness NAME] [--dry-run]
                        How a new agent gets its own identity: a locally unique generated name
                        kept in local pdb.toml (a rerun keeps it; another harness's entry is
                        never reused; nothing is reserved remotely), then the --agent to use
  install codex [--global] [--transport stdio|http] [--url URL] [--role R]
                        Configure the PDB MCP connection for Codex (project default, explicit
                        --global); current slice establishes the command surface only (install codex --help)
  uninstall codex [--global]  Remove only PDB-managed Codex entries; identity and unrelated
                        entries survive (uninstall codex --help)
  onboard [--repo owner/name] [--role implementer|designer] [--server URL] [--install] [--json]
                        New here? How an agent starts with pdb: rules, identity, commands and
                        a prompt to give it; --install adds the pdb section to AGENTS.md
  contributors [--repo owner/name] [--json]  Read-only: the verified checkout's CONTRIBUTORS.md
                        routing guidance (accounts, areas, an explicit "Default: @login"),
                        with its digest and revision; missing or unsafe guidance exits 2
  --repo owner/name     Repository (default: current gh checkout)
  --json                Versioned structured output (from a checkout: npm run --silent pdb)
  --issue N             Include full issue body/history, even if closed; diagnoses
                        transferred, missing or forbidden issues instead of failing
  --include-transferred With --issue: follow a transfer to the destination's intake
  --since ISO           Include changed issues/PRs in all states since timestamp
  --checkpoint PATH     Read last successful window; advance only after complete live output
  --cache PATH          Save full successful snapshot atomically. If GitHub refuses the live
                        read for quota, show this snapshot instead, labelled STALE, when it is
                        of this repository and at most 30 minutes old (exit 2; nothing written)
  --offline             Read explicit cache; no GitHub queries/checkpoint advancement
  --full                Expanded version-1 report
  --agent NAME          Override the effective agent for this call: attention:NAME first,
                        then agent:NAME work; human views use it as their existing routing filter
  --entry KEY           Select a local logical identity entry explicitly; returning sessions
                        verified sessions reuse the saved binding without an agent-name echo;
                        unsupported sessions keep passing --entry KEY on every invocation
  --harness NAME        Select a supported local harness; ambiguity still needs --entry KEY
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
  --section ID          One section of the role view with its row cap lifted (text budget still
                        applies). implementer: ${roleSectionIds("implementer").join(", ")}.
                        designer: ${roleSectionIds("designer").join(", ")}
  --label NAME          Only candidates carrying every given label (repeatable, AND, up to 8);
                        a filtered view, never a whole-board all-clear. Facts stay complete
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
      ...identitySelectionOptions,
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
      ...identitySelectionOptions,
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
    return {
      ...identitySelection(values),
      migrate: "plan",
      file: values.plan,
      repo: values.repo,
      json: values.json,
    };
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
      ...identitySelection(values),
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
      ...identitySelection(values),
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
    ...identitySelection(values),
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
  "Usage: pdb release N [--agent NAME] --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL] [--dry-run] [--json]";
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
  "Usage: pdb question resolve|withdraw N [--agent NAME] --question URL --why TEXT [--dry-run] [--json] [--repo owner/name]";

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
      ...identitySelectionOptions,
      question: { type: "string" },
      why: { type: "string" },
    },
  });
  const [op, issue] = positionals;
  if (
    positionals.length !== 2 ||
    (op !== "resolve" && op !== "withdraw") ||
    !/^[1-9]\d*$/.test(issue ?? "") ||
    (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(values.agent)) ||
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
    ...identitySelection(values),
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
      ...identitySelectionOptions,
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
      ? "Usage: pdb claim N [--agent NAME] [--branch BRANCH] [--platform P] [--rework] [--dry-run] [--json]"
      : command === "release"
        ? releaseUsage
        : "Usage: pdb needs-human N [--agent NAME] --designer NAME --why TEXT --question TEXT [--question TEXT...] [--release] [--dry-run] [--json]";
  const number =
    positionals.length === 1 && /^[1-9]\d*$/.test(positionals[0]) ? Number(positionals[0]) : null;
  const name = /^[A-Za-z0-9][\w.-]*$/;
  if (!number || (values.agent !== undefined && !name.test(values.agent))) throw new Error(usage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const common = {
    number,
    agent: values.agent,
    ...identitySelection(values),
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
  "Usage: pdb claim wait N [--agent NAME] (--question URL | --blocked-by owner/name#M) --why TEXT [--dry-run] [--json] [--repo owner/name]\n       pdb claim resume N [--agent NAME] [--dry-run] [--json] [--repo owner/name]";

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
      ...identitySelectionOptions,
      question: { type: "string" },
      "blocked-by": { type: "string" },
      why: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !/^[1-9]\d*$/.test(positionals[0]!) ||
    (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(values.agent))
  )
    throw new Error(claimWaitUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const common = {
    op,
    number: Number(positionals[0]),
    agent: values.agent,
    ...identitySelection(values),
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
      entry: { type: "string" },
      harness: { type: "string" },
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
      section: { type: "string" },
      label: { type: "string", multiple: true },
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
  // #312: an AND label filter over the compact role/briefing candidates. It is resolved live
  // against the repository, so offline, full intake and issue detail are separate requests.
  if (values.label !== undefined) {
    const normalized = normalizeLabelRequest(values.label);
    if (!normalized.ok) throw new Error(normalized.why);
    if (values.full || values.issue || values.offline)
      throw new Error(
        "--label filters a live compact briefing; run --full, --issue N or --offline as a separate request.",
      );
    if (values.role === "human")
      throw new Error("--role human is a view of human input; it takes no --label filter.");
  }
  // #311: one named section of the role view; contradictory requests are refused, not guessed.
  if (values.section !== undefined) {
    if (values.full || values.issue)
      throw new Error(
        "--section shows one section of the role view; run --full or --issue N as a separate request.",
      );
    if (values.role === "human")
      throw new Error("--role human has no sections to select; omit --section.");
    // Without --role the role is resolved later (configured triage role or engine default),
    // and the projection validates the ID against that role's registry.
    const ids = values.role === undefined ? null : roleSectionIds(values.role);
    if (ids && !ids.includes(values.section))
      throw new Error(`--section for role ${values.role} must be one of: ${ids.join(", ")}.`);
  }
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
/**
 * A locked, durable plain overwrite (#382, src/config/safejson.ts): explicit files such as
 * plans keep their overwrite semantics. Throws when nothing was written.
 */
export async function atomicJson(path: string, value: unknown): Promise<WriteOutcome> {
  const outcome = await overwriteJson(path, value);
  if (outcome.status === "not-written") throw new Error(outcome.reason);
  return outcome;
}

/** Say what a committed write left unconfirmed or uncleaned, never discarding it (#382). */
const reportWrite = (runtime: Runtime, path: string, outcome: WriteOutcome): void => {
  const say = runtime.stderr ?? ((text: string) => void process.stderr.write(text));
  if (outcome.status === "committed-with-error") say(`pdb: ${path}: ${outcome.reason}\n`);
  for (const note of outcome.cleanup) say(`pdb: ${note}\n`);
};

/**
 * Write an explicit `--cache` snapshot (#382): locked, never replacing a newer snapshot of the
 * same repository or an unreadable file. Anything other than a clean write is said on stderr.
 */
async function cacheSnapshot(runtime: Runtime, path: string, snapshot: Snapshot): Promise<void> {
  const say = runtime.stderr ?? ((text: string) => void process.stderr.write(text));
  const outcome = await writeSnapshotCache(path, snapshot);
  if (outcome.status !== "written") say(`pdb: --cache ${path}: ${outcome.reason}\n`);
  for (const note of outcome.cleanup) say(`pdb: ${note}\n`);
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
/** Why a stale snapshot is shown instead of a live read (#371, doc/design/read-degradation.md). */
export interface StaleFallback {
  reason: "live-read-quota-refused";
  /** The explicit snapshot file that was reused. */
  cache: string;
  /** Retry evidence actually observed on the refusal; null when GitHub sent none. */
  retryAfterSeconds: number | null;
  resetAt: string | null;
  /** The effective age limit: the same bound as the server's stale window. */
  maxAgeSeconds: number;
}

/**
 * The cached snapshot's history, fitted to the requested window (#371). No window requested:
 * none is shown. A cached complete window that starts at or before the requested one: its
 * changes narrowed to the request. Otherwise the inventory is kept and the requested window is
 * marked failed, so its changes are unknown rather than none. Briefing-mode change evidence is
 * dropped: it belongs to the cached window, not the requested one.
 */
function staleWindow(snapshot: Snapshot, requestedSince: string | undefined): Snapshot {
  const { changeEvidence: _dropped, history, ...rest } = snapshot;
  if (requestedSince === undefined) return { ...rest, since: null, changed: [] };
  const cachedFrom = snapshot.since === null ? Number.NaN : Date.parse(snapshot.since);
  const from = Date.parse(requestedSince);
  const covered =
    Number.isFinite(cachedFrom) &&
    cachedFrom <= from &&
    (history === undefined || history.state === "complete");
  if (covered)
    return {
      ...rest,
      since: requestedSince,
      changed: snapshot.changed.filter((c) => Date.parse(c.updatedAt) >= from),
      ...(history ? { history: { ...history, since: requestedSince } } : {}),
    };
  return {
    ...rest,
    since: requestedSince,
    changed: [],
    history: { since: requestedSince, state: "failed", failure: "rate-limited", sources: [] },
    warnings: [
      ...snapshot.warnings,
      `The requested history window since ${requestedSince} is not covered by the cached snapshot (${snapshot.since === null ? "it holds no history window" : `its window starts at ${snapshot.since}${history && history.state !== "complete" ? ` and is ${history.state}` : ""}`}); changes in that window are unknown, not none.`,
    ],
  };
}

/**
 * On a quota refusal of the live read, reuse the caller's explicit `--cache` snapshot when it is
 * a valid snapshot of the same repository observed within the age limit (#371). Anything else
 * (no cache, absent, corrupt, foreign, focused, expired) is a distinct diagnosis, never an empty
 * report. The refusal's own retry evidence is kept; nothing is retried here.
 */
export async function quotaFallback(
  error: unknown,
  cache: string | undefined,
  repository: string,
  now: Date,
  /** The history window this read requested (--since or the checkpoint); undefined for none. */
  requestedSince?: string,
): Promise<{ snapshot: Snapshot; stale: StaleFallback }> {
  const retry = prop(error, "retry");
  const retryAfterSeconds = prop(retry, "retryAfterSeconds");
  const resetAt = prop(retry, "resetAt");
  const when =
    typeof resetAt === "string"
      ? ` (quota resets at ${resetAt})`
      : typeof retryAfterSeconds === "number"
        ? ` (retry after ${retryAfterSeconds}s)`
        : " (no reset time was reported)";
  const refused = `GitHub refused the live read for quota${when}`;
  if (!cache)
    throw new Error(
      `${refused}. No stale fallback: no --cache PATH snapshot was given. Retry after the reset.`,
    );
  let snapshot: Snapshot;
  try {
    snapshot = await cachedSnapshot(cache, repository);
  } catch (failure) {
    const why =
      isRecord(failure) && failure.code === "ENOENT"
        ? `${cache} does not exist`
        : failure instanceof SyntaxError
          ? `${cache} is corrupt (not valid JSON)`
          : `${cache} is not a usable snapshot of ${repository}: ${(failure as Error).message}`;
    throw new Error(`${refused}. No stale fallback: ${why}. Retry after the reset.`);
  }
  const maxAgeSeconds = STALE_WINDOW_MS / 1000;
  const age = Math.floor((now.getTime() - Date.parse(snapshot.fetchedAt)) / 1000);
  if (!Number.isFinite(age) || age > maxAgeSeconds)
    throw new Error(
      `${refused}. No stale fallback: ${cache} was observed at ${snapshot.fetchedAt}, older than the ${maxAgeSeconds / 60}-minute limit. Retry after the reset, or read it explicitly with --offline --cache ${cache}.`,
    );
  const stale: StaleFallback = {
    reason: "live-read-quota-refused",
    cache,
    retryAfterSeconds: typeof retryAfterSeconds === "number" ? retryAfterSeconds : null,
    resetAt: typeof resetAt === "string" ? resetAt : null,
    maxAgeSeconds,
  };
  const fitted = staleWindow(snapshot, requestedSince);
  return {
    stale,
    snapshot: {
      ...fitted,
      warnings: [
        ...fitted.warnings,
        `STALE: ${refused}; showing the ${cache} snapshot observed at ${snapshot.fetchedAt} (${Math.max(0, age)}s old, limit ${maxAgeSeconds}s). Refresh before acting: claims and other changes read live and will not use it.`,
      ],
    },
  };
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
const deliveryBoundaries = async (runtime: Runtime, repository: string, offline: boolean) => ({
  ...(!offline && runtime.rest && runtime.query
    ? {
        trust: markerTrust(permissionLookup(repository, runtime.rest)),
        trustWith: (rest: Rest) => markerTrust(permissionLookup(repository, rest)),
        live: { query: runtime.query, rest: runtime.rest },
      }
    : {}),
  // #301: the declared review policy of this verified checkout (another repository's is never
  // read: a mismatched checkout is reported as undeclared, no-matching-project).
  reviewPolicy: await resolveReviewPolicy(repository, runtime.guide ?? {}),
});

export async function main(
  args: string[],
  output: Output = (text) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
    ),
  runtime: Runtime = {
    collect,
    collectShortlist,
    ...(!process.env.PDB_NO_EFFECTIVE_IDENTITY
      ? {
          prepareIdentity: (options) =>
            prepareCommandIdentity(options, {
              env: process.env,
              auth: humanContextEnabled() ? ghAuthContext : undefined,
            }),
        }
      : {}),
    ...(humanContextEnabled()
      ? { briefingHuman: (offline: boolean) => resolveHumanContext(ghAuthContext, { offline }) }
      : {}),
    currentRepository,
    dependencyReport,
    rest: ghRest,
    query: ghQuery,
  },
): Promise<number> {
  // Version check (#51, cached daily per user by #65): runs alongside the command, bounded by a short timeout, and reports
  // only on stderr so JSON on stdout stays valid. --offline and opt-outs mean no network.
  const optOut =
    args.includes("--no-update-check") ||
    !!process.env[optOutEnv] ||
    !!process.env[legacyOptOutEnv];
  const rest = args.filter((a) => a !== "--no-update-check");
  const check = runtime.updateCheck ?? cachedCheckForUpdate;
  // An injected probe always runs; the real one honours its own opt-out too.
  const checkoutCheck: typeof checkoutFreshness =
    runtime.checkoutCheck ??
    ((o) => checkoutFreshness({ ...o, optOut: o.optOut || !!process.env[checkoutOptOutEnv] }));
  if (rest[0] === "version") {
    const installed = await installedVersion();
    const [result, checkout] = await Promise.all([
      check({ offline: rest.includes("--offline"), optOut, installed }),
      checkoutCheck({ root: installed.root ?? null, installed: installed.installed, optOut }),
    ]);
    await output(
      rest.includes("--json")
        ? JSON.stringify(
            {
              schemaVersion: 1,
              version: installed.version,
              // The local source root, as the text output shows it; null for an npm install.
              installation: installed.installed ? null : (installed.root ?? null),
              check: result,
              checkout,
            },
            null,
            2,
          ) + "\n"
        : `pdb ${installed.version ?? "(unknown version)"}\nUpdate check: ${result.status}${"reason" in result && result.reason ? ` — ${result.reason}` : ""}${"available" in result && result.available ? ` (npm ${result.channel}: ${result.available})` : ""}\n${installed.installed ? "" : `Installation: ${installed.root ?? "unknown"}\n${describeCheckout(checkout).join("\n")}\n`}`,
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
    rest[0] !== "serve" &&
    rest[0] !== "rebrief";
  const pending = eligible
    ? Promise.resolve()
        .then(() => check({ offline: rest.includes("--offline"), optOut }))
        .catch(() => null)
    : Promise.resolve(null);
  // Source-checkout freshness (#309): local Git only, so it runs offline too; never fatal.
  const checkoutPending = eligible
    ? installedVersion()
        .then((i) => checkoutCheck({ root: i.root ?? null, installed: i.installed, optOut }))
        .catch(() => null)
    : Promise.resolve(null);
  // First-use pointer (#351): ordinary briefing text only, once per project and version.
  const briefingText =
    (rest[0] === undefined || rest[0].startsWith("-")) &&
    !rest.includes("--json") &&
    !rest.includes("--help") &&
    !rest.includes("-h");
  const hintPending = briefingText
    ? showFirstUseHint(rest, runtime).catch(() => false)
    : Promise.resolve(false);
  try {
    const identity = runtime.prepareIdentity
      ? new CommandIdentity(
          runtime.prepareIdentity,
          output,
          runtime.stderr ??
            ((text) => {
              process.stderr.write(text);
            }),
        )
      : undefined;
    try {
      return await run(
        rest,
        identity ? (text) => identity.output(text) : output,
        runtime,
        identity,
      );
    } catch (error) {
      if (error instanceof IdentityPreparationRequired && identity) return identity.refusal();
      throw error;
    }
  } finally {
    if (await hintPending)
      (runtime.stderr ?? ((t) => process.stderr.write(t)))(`${firstUseHintText}\n`);
    const advisory = updateAdvisory(
      (await pending) ?? { status: "unknown", reason: "", installed: null, channel: "" },
    );
    if (advisory) (runtime.stderr ?? ((t) => process.stderr.write(t)))(`${advisory}\n`);
    // #382: a lock this check could not remove blocks later checks; say how to recover.
    const lockProblem = (await pending)?.lockProblem;
    if (lockProblem) (runtime.stderr ?? ((t) => process.stderr.write(t)))(`pdb: ${lockProblem}\n`);
    const checkout = await checkoutPending;
    const stale = checkout && checkoutAdvisory(checkout);
    if (stale) (runtime.stderr ?? ((t) => process.stderr.write(t)))(`${stale}\n`);
  }
}

/** The project key (--repo, else this checkout's root) and version for the first-use hint. */
async function showFirstUseHint(args: string[], runtime: Runtime): Promise<boolean> {
  if (!runtime.firstUseHint && process.env[firstUseHintOptOutEnv]) return false;
  const at = args.indexOf("--repo");
  let project = at >= 0 ? args[at + 1] : undefined;
  if (!project) {
    const runGit = runtime.config?.git ?? nodeGit;
    const top = await runGit(
      ["rev-parse", "--show-toplevel"],
      runtime.config?.cwd ?? process.cwd(),
    );
    project = top.trim();
  }
  if (!project) return false;
  const version = (await installedVersion()).version ?? "unknown";
  return (runtime.firstUseHint ?? firstUseHint)(project, version);
}

/**
 * `pdb rules` (#416): the compiled policy. Local and credential-free: it reads only the bundled
 * artifact. The document is built and validated before anything is printed, so a failure never
 * leaves a partial listing on stdout. Exit 2 for arguments, 1 for a missing or stale artifact.
 */
async function runRules(args: string[], output: Output, runtime: Runtime): Promise<number> {
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  if (args[0] === "init") return runRulesInit(args.slice(1), output, runtime, stderr);
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
  // #516: the checkout this command runs in decides whether project preferences are in force.
  const guide = runtime.guide ?? {};
  let repository: string | null = null;
  try {
    repository = (
      await resolveRepositoryTarget(guide.cwd ?? process.cwd(), undefined, guide.git ?? nodeGit)
    ).repository;
  } catch {
    repository = null;
  }
  const { project, limits } = await projectRulesContext(
    repository
      ? { repository, runtime: guide }
      : {
          unknown:
            "pdb rules is not running inside a GitHub project checkout, so no project configuration is read and whether project preferences are in force is unknown",
        },
  );
  let text: string;
  try {
    const document = rules.rulesDocument(
      { ...declaredRulesContext(), project },
      { rule: values.rule, role: values.role },
      undefined,
      limits,
    );
    text = values.json ? `${JSON.stringify(document, null, 2)}\n` : rules.rulesText(document);
  } catch (error) {
    stderr(`pdb rules: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof rules.RulesArgumentError ? 2 : 1;
  }
  await output(text);
  return 0;
}

/**
 * `pdb rules init` (#516): writes a reviewable `pdb.rules.edn` starter bound to the shipped
 * policy into the verified checkout this runs in. It never overwrites a file (or a symlink) and
 * never enables anything: enabling is the explicit `pdb config set rules.project.enabled true`.
 */
async function runRulesInit(
  args: string[],
  output: Output,
  runtime: Runtime,
  stderr: (text: string) => void,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    await output(
      "Usage: pdb rules init\nWrites a starter pdb.rules.edn, bound to the shipped policy, at the root of this Git checkout.\nIt refuses to overwrite an existing file and enables nothing: review and commit it, then run\npdb config set rules.project.enabled true.\n",
    );
    return 0;
  }
  if (args.length) {
    stderr("pdb rules init: takes no arguments. Run pdb rules init --help.\n");
    return 2;
  }
  const guide = runtime.guide ?? {};
  let root: string;
  try {
    root = (
      await resolveRepositoryTarget(guide.cwd ?? process.cwd(), undefined, guide.git ?? nodeGit)
    ).root;
  } catch {
    stderr(
      "pdb rules init: run it inside the GitHub project checkout the rules are for; no file was written.\n",
    );
    return 2;
  }
  const rules = await import("./rules/datalog/datalog.js");
  const base = { policyVersion: rules.policyVersion, rulesHash: rules.rulesHash };
  const text = rules.starterProjectRules(base);
  // The starter must itself validate against the shipped policy before it is written.
  rules.compileProjectPolicy(text, base);
  const { open } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    // Exclusive create: an existing file, directory or symlink (even a dangling one) is refused.
    const handle = await open(join(root, "pdb.rules.edn"), "wx", 0o644);
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    stderr(
      code === "EEXIST"
        ? "pdb rules init: pdb.rules.edn already exists in this checkout; it was not changed. Review it with pdb rules, or move it aside to generate a new starter.\n"
        : `pdb rules init: pdb.rules.edn could not be written (${typeof code === "string" ? code : "error"}); nothing was enabled.\n`,
    );
    return 1;
  }
  await output(
    `Wrote pdb.rules.edn (bound to policy ${base.policyVersion}, rulesHash ${base.rulesHash.slice(0, 12)}) at the root of this checkout. Nothing is enabled yet.\nReview it (pdb rules shows it once enabled), commit it, then enable it:\n  pdb config set rules.project.enabled true\n`,
  );
  return 0;
}

/** `pdb issue create` (#199, doc/design/issue-creation.md). */
async function runIssue(
  args: string[],
  output: Output,
  runtime: Runtime,
  identity?: CommandIdentity,
): Promise<number> {
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
        assignee: { type: "string", multiple: true },
        repo: { type: "string" },
        agent: { type: "string" },
        ...identitySelectionOptions,
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
      },
    }));
  } catch {
    throw new Error(issueCreateUsage);
  }
  if (values.title === undefined) throw new Error(`--title is required. ${issueCreateUsage}`);
  if (identity) {
    values.repo ??= await runtime.currentRepository();
    values.agent = await commandActor(
      { ...values, dryRun: !!values["dry-run"] },
      identity,
      issueCreateUsage,
    );
  }
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  const hasLegacyOverrides =
    runtime.rest !== undefined ||
    runtime.issueCreate?.rest !== undefined ||
    runtime.issueCreate?.post !== undefined;
  const rt: IssueCreateRuntime = {
    ...(hasLegacyOverrides
      ? { rest: runtime.rest ?? ghRest, post: ghPost }
      : { issues: ghService.issues }),
    currentRepository: () => runtime.currentRepository(),
    now: runtime.now ?? (() => new Date()),
    operationId: defaultOperationId,
    readFile: defaultReadFile,
    readStdin: readStdinBounded,
    stderr,
    targetContext: async (repository) => {
      const cwd = runtime.config?.cwd ?? runtime.guide?.cwd ?? process.cwd();
      const git = runtime.config?.git ?? runtime.guide?.git ?? nodeGit;
      const fs = runtime.config?.fs ?? runtime.guide?.fs ?? nodeFileSystem;
      let target;
      try {
        target = await resolveRepositoryTarget(cwd, repository, git);
      } catch (error) {
        return {
          verified: false,
          reason:
            error instanceof ConfigError
              ? error.message
              : `${repository} has no verified local checkout.`,
        };
      }
      let loaded;
      try {
        loaded = await loadConfig(target.root, fs);
      } catch (error) {
        return {
          verified: false,
          reason:
            error instanceof ConfigError
              ? error.message
              : `Cannot read repository policy in ${target.root}.`,
        };
      }
      if (loaded.format === null) {
        return {
          verified: false,
          reason: `No PDB policy configuration (.github/triage.toml) found in ${target.root}; ${repository} is not a PDB-managed checkout.`,
        };
      }
      return { verified: true, repository: target.repository };
    },
    ...(identity?.result
      ? { employingHuman: async () => identity.result!.human }
      : runtime.briefingHuman
        ? { employingHuman: () => runtime.briefingHuman!(false) }
        : {}),
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
        ...(values.assignee !== undefined ? { assignees: values.assignee } : {}),
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
async function run(
  args: string[],
  output: Output,
  runtime: Runtime,
  identity?: CommandIdentity,
  inheritedIdentity?: EffectiveIdentity,
): Promise<number> {
  if (args[0] === "rules") return runRules(args.slice(1), output, runtime);
  if (args[0] === "process") {
    const { values } = parseArgs({ args: args.slice(1), options: { json: { type: "boolean" } } });
    await output(values.json ? JSON.stringify(fullGuideJson(), null, 2) + "\n" : fullGuideText());
    return 0;
  }
  if (args[0] === "briefing")
    return runBriefing(args.slice(1), output, {
      ...runtime,
      ...(identity
        ? {
            prepareViewer: (values: import("./briefing/catchupcli.js").BriefingArguments) =>
              commandViewer(values, identity),
          }
        : {}),
      files: runtime.briefingFiles ?? {
        atomicJson,
        cachedSnapshot,
        checkpointSince,
        advanceCheckpoint,
        writeSnapshotCache,
      },
    });
  if (args[0] === "serve") return runServe(args.slice(1), runtime.serve);
  if (args[0] === "rebrief")
    return runRebrief(args.slice(1), output, {
      prepareIdentity: runtime.prepareIdentity,
      read: {
        collect: runtime.collect,
        dependencyReport: runtime.dependencyReport ?? dependencyReport,
        rest: runtime.rest,
        query: runtime.query,
        queryWith: runtime.query === ghQuery ? ghQueryWith : undefined,
        now: runtime.now,
      },
      ...runtime.rebrief,
    });
  if (args[0] === "issue") return runIssue(args.slice(1), output, runtime, identity);
  if (args[0] === "quotas")
    return runQuotas(args.slice(1), output, {
      account: createGhService({ rest: runtime.rest ?? ghRest, now: runtime.now }).account,
      host: () => process.env.GH_HOST?.trim() || "github.com",
      now: runtime.now,
      ...runtime.quotas,
    });
  if (args[0] === "config") return runConfig(args.slice(1), output, runtime.config);
  if (args[0] === "setup") return runSetup(args.slice(1), output, runtime.config);
  if (args[0] === "install" || args[0] === "uninstall") {
    const operation = args[0] === "install" ? "install" : "uninstall";
    const parsed = installArgumentsFor(args.slice(1), operation);
    if (parsed.help) {
      await output(installHelp(operation));
      return 0;
    }
    return runCodexInstallSurface(parsed, runtime.config ?? {}, output);
  }
  if (args[0] === "onboard") return runOnboard(args.slice(1), output, runtime.config);
  if (args[0] === "contributors") return runContributors(args.slice(1), output, runtime.config);
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
        agent: { type: "string" },
        ...identitySelectionOptions,
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
    const identitySnapshot =
      identity && values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : undefined;
    if (identity)
      values.repo ??= identitySnapshot?.repository ?? (await runtime.currentRepository());
    await commandViewer(values, identity);
    const snapshot =
      identitySnapshot ??
      (values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {}));
    if (!values.offline && values.cache) await cacheSnapshot(runtime, values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const impact = await metricStatus(impactMetric, snapshot.repository, runtime.estimation).catch(
      () => "unknown" as const,
    );
    const rest = values.offline ? undefined : runtime.rest;
    const read = await readTicketDoctor(
      snapshot,
      {
        staleHours,
        limit,
        now: runtime.now?.() ?? new Date(),
        offline: !!values.offline,
        impactEnabled: impact !== "disabled",
        ...(values.since !== undefined ? { since: values.since } : {}),
      },
      {
        trust: rest ? markerTrust(permissionLookup(snapshot.repository, rest)) : undefined,
        live: rest ? { query: runtime.query ?? ghQuery, rest } : undefined,
      },
    );
    await output(values.json ? JSON.stringify(read.report, null, 2) + "\n" : read.text);
    return read.complete ? 0 : 2;
  }
  if (args[0] === "submit" || args[0] === "deliverables") {
    const submit = args[0] === "submit";
    if (args.length === 1 || args.slice(1).some((a) => a === "--help" || a === "-h")) {
      await output(submit ? submitHelp : deliverablesHelp);
      return 0;
    }
    const parsed = submit ? submitArguments(args.slice(1)) : deliverablesArguments(args.slice(1));
    if (identity) parsed.repo ??= await runtime.currentRepository();
    const { repo, json, dryRun } = parsed;
    const request = {
      ...parsed.request,
      agent: await commandActor(
        { ...parsed, agent: parsed.request.agent },
        identity,
        submit ? submitHelp : deliverablesHelp,
      ),
    };
    const repository = repo ?? (await runtime.currentRepository());
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = createGhService({ rest: runtime.rest ?? ghRest }).repos.permissionOf(
      repository,
    );
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
    const parsed = completeArguments(args.slice(1));
    if (identity) parsed.repo ??= await runtime.currentRepository();
    const { repo, json, dryRun } = parsed;
    const request = {
      ...parsed.request,
      agent: await commandActor({ ...parsed, agent: parsed.request.agent }, identity, completeHelp),
    };
    const repository = repo ?? (await runtime.currentRepository());
    const gh = createGhService({
      rest: runtime.rest ?? ghRest,
      query: runtime.query,
      run: runtime.ghRun,
    });
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = gh.repos.permissionOf(repository);
    const rt = {
      query: runtime.query ?? ghQuery,
      run: runtime.ghRun ?? ghRun,
      rest: runtime.rest ?? ghRest,
      trust: markerTrust(permission),
      now: runtime.now ?? (() => new Date()),
      completion: gh.completion,
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
    const parsed = questionArgumentsFor(args.slice(1));
    if (identity) parsed.repo ??= await runtime.currentRepository();
    const values = { ...parsed, agent: await commandActor(parsed, identity, questionUsage) };
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const permission = createGhService({ rest: runtime.rest ?? ghRest }).repos.permissionOf(
      repository,
    );
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
    const parsed = claimActivityArgumentsFor(args[1], args.slice(2));
    if (identity) parsed.repo ??= await runtime.currentRepository();
    const values = { ...parsed, agent: await commandActor(parsed, identity, claimWaitUsage) };
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const permission = createGhService({ rest: runtime.rest ?? ghRest }).repos.permissionOf(
      repository,
    );
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
    const parsed = workflowArgumentsFor(args[0], args.slice(1));
    if (identity) parsed.repo ??= await runtime.currentRepository();
    const values = {
      ...parsed,
      agent: await commandActor(
        parsed,
        identity,
        "Use an effective identity or pass --agent NAME for this workflow command.",
      ),
    };
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    // Per run: a permission learned now is never reused by a later invocation.
    const permission = createGhService({ rest: runtime.rest ?? ghRest }).repos.permissionOf(
      repository,
    );
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
        agent: { type: "string" },
        ...identitySelectionOptions,
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
    const identitySnapshot =
      identity && values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : undefined;
    if (identity)
      values.repo ??= identitySnapshot?.repository ?? (await runtime.currentRepository());
    await commandViewer(values, identity);
    const snapshot =
      identitySnapshot ??
      (values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {}));
    if (!values.offline && values.cache) await cacheSnapshot(runtime, values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const { report, text } = await readTeam(
      snapshot,
      { staleHours, now: runtime.now?.() ?? new Date(), offline: !!values.offline },
      await deliveryBoundaries(runtime, snapshot.repository, !!values.offline),
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
    if (identity) values.repo ??= await runtime.currentRepository();
    values.agent = await commandViewer(values, identity);
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
        await deliveryBoundaries(runtime, repository, false),
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
        agent: { type: "string" },
        ...identitySelectionOptions,
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
    const identitySnapshot =
      identity && values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : undefined;
    if (identity)
      values.repo ??= identitySnapshot?.repository ?? (await runtime.currentRepository());
    await commandViewer(values, identity);
    const number = Number(positionals[0]);
    if (!values.offline && !values.cache) {
      // issue-detail-v1 (#367): the ticket and its linked open PRs only, never the repository.
      const repository = values.repo ?? (await runtime.currentRepository());
      const { report, text } = await readWhoLive(
        repository,
        number,
        { staleHours, now: runtime.now?.() ?? new Date() },
        await deliveryBoundaries(runtime, repository, false),
        runtime.query ?? ghQuery,
        runtime.now,
        runtime.collectIssueFocus,
      );
      await output(values.json ? JSON.stringify(report, null, 2) + "\n" : text);
      return report.completeness.complete ? 0 : 2;
    }
    // A cache is written or read: keep the full compatibility snapshot, which a later offline
    // briefing may read as a repository inventory. A focused read is never cached as one.
    const snapshot =
      identitySnapshot ??
      (values.offline
        ? await cachedSnapshot(values.cache ?? "", values.repo)
        : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {
            issue: number,
          }));
    if (!values.offline && values.cache) await cacheSnapshot(runtime, values.cache, snapshot);
    // #301: the declared review policy, after caching (configuration is never cached).
    snapshot.reviewPolicy = await resolveReviewPolicy(snapshot.repository, runtime.guide ?? {});
    const { report, text } = await readWho(
      snapshot,
      number,
      { staleHours, now: runtime.now?.() ?? new Date(), offline: !!values.offline },
      await deliveryBoundaries(runtime, snapshot.repository, !!values.offline),
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
      trust: (repository) =>
        markerTrust(
          createGhService({ rest: runtime.rest ?? ghRest }).repos.permissionOf(repository),
        ),
      ...runtime.estimate,
      ...(identity
        ? {
            prepareActor: async (
              values: import("./config/commandidentity.js").CommandActorOptions,
            ) => {
              const repository = values.repo ?? (await runtime.currentRepository());
              return {
                agent: await commandActor({ ...values, repo: repository }, identity, estimateUsage),
                repository,
              };
            },
          }
        : {}),
    });
  }
  if (args[0] === "pr") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        agent: { type: "string" },
        ...identitySelectionOptions,
        json: { type: "boolean" },
        history: { type: "boolean" },
      },
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw new Error("Usage: pdb pr N [--history] [--json] [--repo owner/name]");
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    if (identity) values.repo ??= await runtime.currentRepository();
    await commandViewer(values, identity);
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    const { report, text } = values.history
      ? await readReviewHistory(repository, Number(positionals[0]), query)
      : await readPullRequest(
          repository,
          Number(positionals[0]),
          query,
          // #192: delivery and responsibility for the issues this PR is linked to close.
          await deliveryBoundaries(runtime, repository, false),
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
    if (identity) values.repo ??= await runtime.currentRepository();
    if ("action" in values) {
      if (identity) await commandActor(values, identity, depsHelp);
    } else if ("migrate" in values) {
      await commandViewer(values, identity, true);
    } else values.agent = await commandViewer(values, identity);
    const repository = values.repo ?? (await runtime.currentRepository());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("--repo must be owner/name.");
    if ("migrate" in values) {
      const plan = await (runtime.planMigration ?? planMigration)(
        repository,
        runtime.migrationRuntime,
      );
      reportWrite(runtime, values.file, await atomicJson(values.file, plan));
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
  const identitySnapshot =
    identity && options.offline
      ? await cachedSnapshot(options.cache ?? "", options.repo)
      : undefined;
  if (identity && !inheritedIdentity)
    options.repo ??= identitySnapshot?.repository ?? (await runtime.currentRepository());
  const effective =
    inheritedIdentity ??
    (identity
      ? await identity.select(
          {
            repository: options.repo,
            agent: options.role === "human" ? undefined : options.agent,
            entry: options.entry,
            harness: options.harness,
            role: options.role === "human" ? undefined : options.role,
            intent: options.role === "human" || options.offline ? "readonly" : "normal",
            offline: !!options.offline,
            authenticationRequired: false,
          },
          { json: !!options.json, allowUnresolved: options.role === "human" || !!options.offline },
        )
      : undefined);
  // A human view's agent flag is its existing routing filter, never an execution-agent override.
  if (effective && options.role !== "human") {
    options.agent = effective.agent ?? undefined;
    options.role = effective.role ?? options.role;
  }
  // Resolve the employing human once; it stays distinct from the human-attention payload.
  const human =
    effective?.human ??
    (runtime.briefingHuman ? await runtime.briefingHuman(!!options.offline) : undefined);
  /**
   * The briefing presentation for `repository`, resolved once: configuration, label filter and
   * one per-run permission cache shared by the shortlist's ranking passes and the final report.
   */
  let presentation:
    | {
        repository: string;
        present: PresentFn;
        meter?: ReadMeter;
        /** The label filter as resolved once for this presentation (#312); null when none. */
        labels: string[] | null;
      }
    | undefined;
  type PresentFn = (
    collected: Snapshot,
    live: boolean,
    reserve?: number,
  ) => ReturnType<typeof presentBriefing>;
  const presentationFor = async (repository: string, meter?: ReadMeter) => {
    if (presentation?.repository === repository) return presentation;
    // #368: the shortlist read's meter also carries permission lookups and delivery reads.
    const rest =
      meter && runtime.rest ? meter.rest(runtime.rest, "permissions", repository) : runtime.rest;
    const query =
      meter && runtime.query
        ? meter.query(runtime.query, "delivery-records", repository)
        : runtime.query;
    const guideProcess = options.full
      ? undefined
      : briefingProcess(await resolveGuideSetting(repository, options.guide, runtime.guide));
    // #312: resolve the label filter live against the repository before projecting.
    // Through the read's meter when there is one (#368): counted, and stopped after a refusal.
    const labels = options.label?.length
      ? await resolveLabelFilter(
          repository,
          options.label,
          meter
            ? meter.query(runtime.query ?? ghQuery, "labels", repository)
            : (runtime.query ?? ghQuery),
        )
      : undefined;
    const presentOptions = {
      ...options,
      ...(human ? { employingHuman: human } : {}),
      ...(labels ? { labels } : {}),
      process: guideProcess,
      engineClock: runtime.engineClock,
      engineSetting:
        options.full || options.issue
          ? undefined
          : await resolveEngineSetting(repository, runtime.guide ?? {}),
      // #516: native project preferences, enabled only by configuration.
      ...(options.full || options.issue
        ? {}
        : { projectRules: await resolveProjectRulesSetting(repository, runtime.guide ?? {}) }),
      // #301: declared review policy from local configuration (legacy when undeclared).
      reviewPolicy: await resolveReviewPolicy(repository, runtime.guide ?? {}),
    };
    // Provenance authority (#247) uses the per-run permission cache; offline reads make no
    // request, so trusted provenance is then unknown. Without an injected boundary, likewise.
    const trust =
      !options.offline && rest ? markerTrust(permissionLookup(repository, rest)) : undefined;
    const present: PresentFn = (collected, live, reserve = 0) =>
      presentBriefing(
        collected,
        { ...presentOptions, maxChars: Math.max(0, presentOptions.maxChars - reserve) },
        runtime.estimation,
        runtime.now?.(),
        undefined,
        trust,
        undefined,
        undefined,
        // #192: delivery evidence is read live only on a live read with both boundaries.
        live && !options.offline && rest && query
          ? {
              query,
              rest,
              trustWith: (other: Rest) => markerTrust(permissionLookup(repository, other)),
            }
          : undefined,
      );
    presentation = { repository, present, meter, labels: labels ?? null };
    return presentation;
  };
  let snapshot: Snapshot;
  let stale: StaleFallback | undefined;
  // #368: a plain live briefing discovers, ranks, then hydrates only its shortlist. Explicit
  // full reads (--full, --issue, --cache, --since/--checkpoint, offline) and the human briefing
  // keep the full snapshot.
  const shortlisted =
    !!runtime.collectShortlist &&
    !options.offline &&
    !options.full &&
    !options.issue &&
    !options.cache &&
    !options.since &&
    !options.checkpoint &&
    options.role !== humanRole;
  if (shortlisted) {
    const repository = options.repo ?? (await runtime.currentRepository());
    const meter = new ReadMeter("briefing-shortlist-v1", "briefing", runtime.now);
    const shared = await presentationFor(repository, meter);
    try {
      snapshot = await runtime.collectShortlist!(
        repository,
        {
          select: async (candidates) =>
            shownSubjects((await shared.present(candidates, false)).report),
          ...(runtime.rest ? { rest: runtime.rest } : {}),
          meter,
        },
        runtime.query,
        runtime.now,
      );
    } catch (error) {
      if (!quotaRefusal(error)) throw error;
      // #371: a quota-refused discovery falls back to the explicit snapshot exactly as a full
      // read does (stale, offline facts; no shortlist presentation).
      ({ snapshot, stale } = await quotaFallback(
        error,
        options.cache,
        repository,
        runtime.now?.() ?? new Date(),
        options.since,
      ));
      options.offline = true;
      // The filter resolved before collection is reused: no second lookup (#368).
      return briefingFrom(snapshot, stale, shared.labels);
    }
    return briefingFrom(snapshot, undefined, shared.labels);
  } else if (options.offline)
    snapshot = identitySnapshot ?? (await cachedSnapshot(options.cache ?? "", options.repo));
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
      if (quotaRefusal(error)) {
        // #371: the explicit snapshot, labelled stale, read from here on exactly as offline
        // facts: no live verification, no checkpoint advance and no cache write.
        ({ snapshot, stale } = await quotaFallback(
          error,
          options.cache,
          repository,
          runtime.now?.() ?? new Date(),
          options.since ?? previous,
        ));
        options.offline = true;
        return briefingFrom(snapshot, stale);
      }
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
          // An explicit transfer follow is the same invocation, not local setup for another repo.
          undefined,
          effective,
        );
      }
      const report = { schemaVersion: 1, kind: "issue-unavailable", ...d };
      await output(options.json ? JSON.stringify(report, null, 2) + "\n" : unavailableText(d));
      return 2;
    }
    // An incomplete history read never replaces the last successful explicit snapshot.
    if (options.cache && historyComplete(snapshot))
      await cacheSnapshot(runtime, options.cache, snapshot);
    else if (options.cache)
      snapshot = {
        ...snapshot,
        warnings: [
          ...snapshot.warnings,
          `${options.cache} was not overwritten: this read's history window is incomplete.`,
        ],
      };
  }
  return briefingFrom(snapshot, stale);

  async function briefingFrom(
    snapshot: Snapshot,
    stale: StaleFallback | undefined,
    /**
     * The label filter already resolved by the shortlist's shared presentation (#368); null
     * when no filter was requested. Undefined: resolve here, as before.
     */
    resolved?: string[] | null,
  ): Promise<number> {
    if (options.issue && !snapshot.issues.some((issue) => issue.number === options.issue))
      throw new Error(`Issue #${options.issue} not in this cache. Refresh live with --issue.`);
    const guideProcess = options.full
      ? undefined
      : briefingProcess(
          await resolveGuideSetting(snapshot.repository, options.guide, runtime.guide),
        );
    // #312: resolve the label filter live against the repository before projecting.
    let labels: string[] | undefined = resolved ?? undefined;
    if (resolved !== undefined) {
      // Already resolved once before collection; no second lookup.
    } else if (options.label?.length && options.offline) {
      // #371: only a stale quota fallback gets here (--offline --label is refused as usage). It
      // must make no further request, so the filter resolves against the snapshot's own labels.
      const normalized = normalizeLabelRequest(options.label);
      const local = labelsFromSnapshot(
        [...snapshot.issues, ...snapshot.pullRequests],
        normalized.ok ? normalized.labels : options.label,
      );
      labels = local.labels;
      if (local.unverified.length)
        snapshot = {
          ...snapshot,
          warnings: [
            ...snapshot.warnings,
            `Label filter not verified live: ${local.unverified.join(", ")} is on no item of this snapshot, so it matches nothing here; that is not proof the label is absent.`,
          ],
        };
    } else if (options.label?.length)
      labels = await resolveLabelFilter(
        snapshot.repository,
        options.label,
        runtime.query ?? ghQuery,
      );
    const rawCheckpointText = options.checkpoint
      ? `Checkpoint: ${!snapshot.since ? "establishing current baseline" : `previous window ${snapshot.since}`}; Advance only after complete successful live output; offline/incomplete results never advance.\n`
      : "";
    const checkpointText =
      rawCheckpointText && rawCheckpointText.length + 31 <= options.maxChars
        ? rawCheckpointText
        : "";
    const briefingBudget = options.maxChars - checkpointText.length;
    // #368: a shortlist read is presented through the shared presentation that ranked it (same
    // configuration, permission cache and read meter), with its PROVISIONAL notice in budget.
    const shortlistLineText = snapshot.shortlist ? shortlistLine(snapshot, briefingBudget) : "";
    const { report, text } =
      snapshot.shortlist && presentation
        ? withShortlist(
            await presentation.present(
              snapshot,
              true,
              shortlistLineText.length + checkpointText.length,
            ),
            snapshot,
            presentation.meter,
            shortlistLineText,
          )
        : await presentBriefing(
            snapshot,
            {
              ...options,
              maxChars: briefingBudget,
              ...(human ? { employingHuman: human } : {}),
              ...(labels ? { labels } : {}),
              ...(stale ? { stale } : {}),
              process: guideProcess,
              engineClock: runtime.engineClock,
              engineSetting:
                options.full || options.issue
                  ? undefined
                  : await resolveEngineSetting(snapshot.repository, runtime.guide ?? {}),
              ...(options.full || options.issue
                ? {}
                : {
                    projectRules: await resolveProjectRulesSetting(
                      snapshot.repository,
                      runtime.guide ?? {},
                    ),
                  }),
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
                  trustWith: (rest: Rest) =>
                    markerTrust(permissionLookup(snapshot.repository, rest)),
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
    await output(
      options.json
        ? JSON.stringify({ ...report, checkpoint }, null, 2) + "\n"
        : text + checkpointText,
    );
    if (!options.offline && options.checkpoint && report.completeness.complete) {
      // Start time deliberately overlaps windows: updates arriving during collection are not lost.
      // #382: under the checkpoint's own lock, for the same repository, never moving it back.
      const advanced = await advanceCheckpoint(options.checkpoint, {
        schemaVersion: 1,
        repository: snapshot.repository,
        through: snapshot.startedAt,
      });
      const say = runtime.stderr ?? ((text: string) => void process.stderr.write(text));
      for (const note of advanced.cleanup) say(`pdb: ${note}\n`);
      if (advanced.status === "not-written" || advanced.status === "committed-with-error") {
        // The report is already on stdout; the cursor's state is said on stderr, never as success.
        say(`pdb: checkpoint ${options.checkpoint}: ${advanced.reason}\n`);
        return 2;
      }
    }
    return report.completeness.complete ? 0 : 2;
  }
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
  await initializeCrashes(
    process.argv[2] === "serve" ? "serve" : "cli",
    fileURLToPath(new URL("../", import.meta.url)),
    (await installedVersion()).version,
  );
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`pdb: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
