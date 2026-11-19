# PDB architecture

This is the main architectural guideline for Presidential Daily Briefing. Start
here when designing, changing or reviewing the system. It defines required
boundaries, not a claim that every planned feature or migration has shipped.

[Research and decision rationale](research/README.md) explain why these choices
were made. [Detailed feature contracts](design/README.md) refine them. Research,
experiments and historical proposals are evidence, not independent policy.

## 1. One owner for each shared capability

When multiple parts of PDB need the same external system, resource or coordinated
capability, define one canonical typed service boundary in its owning area.
Consumers reuse that service; they do not create parallel clients, bypass its
adapter, parse raw responses independently, or copy cache/retry/lifecycle logic.
Extend an existing capability instead of introducing another access path with
overlapping responsibility. See the [decision rationale](research/service-boundaries.md).

A canonical owner is not a giant file. Interfaces, private adapters and focused
helpers may span files within the owning area. Follow the
[source layout](design/source-layout.md): one package, explicit module imports,
no new import cycles, TypeScript namespaces, barrel `index.ts` layers or generic
shared/utils/services dumping ground. Pure formatting, arithmetic and immutable
helpers remain ordinary functions; do not manufacture service classes for them.

## 2. Shared mutable state has an explicit holder

A capability retaining mutable state across calls has a named, scoped state-holder
wrapper around its operations. It owns the state and its synchronization/lifecycle;
consumers get the typed facade, not mutable maps or private state copies.
Caches, in-flight work, cursors, subscriptions, connection pools and applied
configuration are examples of state that needs an explicit owner.

Document the holder's lifetime/scope, creator, consumers, partition keys,
concurrency/cancellation ownership, reset/invalidation/expiration, cleanup and any
persistence boundary. Application composition constructs/injects one holder per
declared scope. Invocation, application, request, session, project and account
scopes are legitimate; no hidden process-global selected repository/account/agent.

Keep operation logic and state management distinguishable. A small named holder
may live beside its factory; an existing valid stateful component such as
ServeCache or application state can already fulfil this role. Do not invent state
or wrap an existing holder in an empty extra layer. Inject clocks/transports and
use bounded read-only snapshots for diagnostics rather than exposing mutable data.

## 3. Composition wires; controllers translate

The application composition root owns construction, injection, explicit startup
and bounded cleanup. One running application has one Git facade and one GH
facade, shared with its consumers; this is not one singleton across processes.
Construction must not hide ticket prefetch, identity allocation, polling or other
unrequested work. Partial startup cleans up only resources it acquired.

Feature services coordinate domain operations through injected dependencies.
CLI, HTTP and MCP controllers validate transport input, call services and project
results/errors. They do not construct independent clients, parse utility output
or create a second workflow engine. Shared services are directly usable without
HTTP loopback. Browser components call HTTP APIs, not CLI/MCP or external systems.

Configuration owns values, validation, safe writes and factual changes. Serve-only
application state owns saved/running/applied snapshots and restart consequences;
it does not construct other services. CLI config operations use configuration
directly without a serve listener/state. See
[configuration layers](design/serve-configuration-layers.md),
[application state](design/serve-application-state.md) and
[service composition](design/github-service-composition.md).

## 4. Typed Git and GH boundaries

Every main PDB command/subcommand and its feature/controller modules uses the
respective typed Git or GH service. Only private adapters execute the utilities
or handle raw argument arrays, queries and response parsing. Callers use named
asynchronous capabilities and validated typed results; a cast or opaque JSON
passthrough is not validation. Preserve absence/unknown separately from failure.

Use installed Git through its existing injectable runner; no new Git library is
selected. GH uses the existing authenticated `gh`; no new credentials, competing
HTTP collector or browser GitHub client. Use explicit checkout/host/account/repo
context, literal argument arrays without a shell, bounded output and cancellation.
Derive checkout identity from verified remotes, not a stale `GH_REPO` override.
Repository identities remain opaque: no repository/issue/agent-name special cases.

Release scripts and standalone tooling retain the owner's direct-Git exception
and existing safeguards. A helper used by the main application is not exempt
because it lives in scripts/. Display-only user commands and disposable fixtures
are not production execution sites. Preserve documented standalone GH tooling
exclusions without extending them to application code. The
[module migration map](design/git-gh-module-migrations.md) tracks existing debt.

## 5. Native rules own workflow decisions

Workflow eligibility, ranking, ownership/admission and completion decisions belong
to the shared native rules engine. Services gather facts and execute mechanics;
controllers, pages and transport adapters must not recreate those decisions.
TypeScript may validate/parse evidence, fold records, aggregate supplied metric
facts and perform protocol/filesystem mechanics; it is not a parallel ranker.

Extend registered roles, rule handlers and declarative policy. Edit native EDN
sources, never generated policy JSON. Keep formal decisions and their explanations
consistent across CLI, MCP, rebrief and serve. Native blockedBy/blocking edges are
authoritative; issue-body dependency text is migration/drift evidence only.
See [rules](design/rules-component.md) and [native policy rationale](research/native-policy.md). Estimation review, needs-refinement admission and the discussion view follow the [estimation and refinement contract](design/estimation-refinement-loop.md).

GitHub human assignment and agent claims are distinct. Agents work within their
employing human's assignment and the shared native admission rules; claims never
silently grant ownership. Explicit human direction and safe parking/handoff follow
the [human-assignment contract](design/human-assignment-safeguard.md), including
preservation of partial work and existing owners. Do not infer authority from a
shared login, PR author, model name or arbitrary client/session input.

## 6. Evidence, caching and writes stay truthful

Preserve versioned schemas, explicit freshness/completeness, full intake,
offline/checkpoint safety and useful omissions. Unknown is not empty, clean,
eligible, answered, delivered or approved. Keep dated examples distinct from live
data. Derive metrics and drill-down membership from the same supporting evidence.

Reuse shared cache/read machinery, with explicit context keys, bounds, refresh,
in-flight joining and cancellation ownership. Do not stack independent caches or
reuse another account/project's facts. A fresh read cannot silently return stale
facts; retain observed-at and coverage. Current inventory is not historical flow.

Mutations retain admission, revision/guard checks, provenance, ordered receipts,
partial outcomes and uncertain dispatch. Do not cache writes, retry them blindly
or report success when only a plan/queue entry exists. Invalidate affected reads
honestly after confirmed/uncertain writes. Never apply live dependency migration
without a reviewed plan. Use injected GH/clock/filesystem boundaries in tests.

## 7. Serve is API-first

Backend services own domain content, effective configuration, rules and native
decisions. Versioned data/text APIs expose them independently of presentation.
Frontend components own markup and interaction state; they display supplied
content instead of regenerating rules or workflow logic.

New/migrated pages use built frontend assets/static bootstrap, not backend HTML
strings or browser `innerHTML` assembly of domain content. Existing generated
pages migrate incrementally. Keep project/identity context isolated, lazy reads,
clear loading/partial/error states and existing Host/Origin/CSP controls. Do not
smuggle a security framework or full UI rewrite into a small feature.
See the [API-first contract](design/serve-api-first-frontend.md) and
[UI rationale](research/api-first-ui.md).

## 8. Source, configuration and private data

Project prose, PRs and explanatory comments are English. Application code and
maintained executable research examples use strict TypeScript; installed consumers
run built JavaScript bundles. Use tsx for source execution and Vite+ for checks,
tests and builds. Follow the [current-LTS runtime policy](design/runtime.md).

Scripts may use the documented ancillary-language exceptions, with purpose,
runtime/platform support and validation recorded in `LANGUAGE_EXCEPTIONS`.
Application/scripts code does not import those non-TypeScript files; selected
ancillary languages such as Datalog retain their explicit validation boundary.
See [language policy](design/typescript.md).

Prefer TOML for project-owned configuration; manifests/workflows keep their required
formats. Public settings live in `.github/triage.toml`; legacy JSON follows the
[conversion contract](design/configuration-formats.md). Private root `pdb.toml`
contains per-agent identity and stays ignored/unversioned. Preserve unrelated keys;
import legacy entries only through the supported one-time setup path and never
write agent-inbox's file. Use config/setup APIs rather than hand-edit identity.

Keep agent, human, logical entry, harness/session and selected repository distinct.
Observational human reads need no agent identity and must not mint/borrow one;
agent-attributed mutations retain their guards. See
[effective identity](design/effective-identity.md). Never commit tokens, private
settings, identity files or live snapshots; no external communications check-in
is an architectural dependency.

## 9. Architecture-first change and review

For new shared capabilities, name the canonical owner/public entry point,
consumers, reused services and any state-holder/lifetime. Reject new bypasses,
parallel clients/caches, hidden shared state and policy duplication. Document
narrow exceptions and existing migration debt explicitly.

A changed architectural contract lands in a separate reviewed docs PR before
implementation. Accurate merged contracts can be reused. Change this document for
new cross-cutting principles; keep feature-level details in linked contracts,
which refine rather than independently override these rules. If they conflict,
resolve the conflict explicitly instead of silently choosing a convenient source.
Research records preserve evidence and uncertainty; new policy is decided here.

Codex and CodeRabbit prioritize consistency with this document and applicable
contracts. Findings identify a changed line, the violated principle and a concrete
consequence. Baseline debt is not a reason to demand an unrelated rewrite; a PR
claiming a migration complete must actually remove its scoped bypasses. Still
report material correctness, data-loss, security and compatibility defects.
Avoid style-only noise. Follow the [shared review prompt](../.github/review-guidelines.md)
and unchanged [merge gate](design/review-gate.md).

## 10. Policy before integration and ticket types

When a change affects native workflow decisions, normally deliver a dedicated
`type:policy` ticket first: decision inputs/outputs, native rules, decision-matrix
scenarios and only the minimal fact-adapter work needed to validate them. Once it
passes required checks/review and merges, a dependent `type:engineering` ticket
integrates the decision into TypeScript mechanics, writes, transports or UI.
Policy tests alone do not complete the overall feature. Native dependencies enforce
ordering; ticket types do not create a second workflow engine.

Use `type:policy`, `type:documentation` or `type:engineering` on new tickets going
forward, according to their primary scope. Roles remain separate: an implementer
may deliver policy or engineering. Do not relabel the historical backlog or require
extra slices for a routine change with no decision-policy impact. Documentation
contracts still precede behavior changes; a policy implementation is not a substitute
for reviewing the changed architectural contract.

Logging and overrides follow the [local logging](design/local-logging.md),
[force override](design/human-force-overrides.md) and
[human responsibility release](design/human-responsibility-release.md) contracts.

## 11. Generated action guidance and onboarding

Modifying operations should, where practical, show applicable current rules in
English through the shared native policy/document generator. Distinguish admission
reasons from ongoing obligations and actual success from no-op/partial/failure.
Keep routine work-list reads unchanged. Never duplicate policy text in command
handlers; keep machine-readable receipts intact. Missing native obligation coverage
is a policy ticket before its display integration. See
[action reminders](design/action-rule-reminders.md).

[Onboarding](design/onboarding-rules-files.md) may write an explicitly managed,
refreshable rules.md snapshot and its AGENTS.md reference in a verified project;
that snapshot is not a competing policy authority. npm installation only hints at
onboarding and never edits the user's project or configures an agent automatically.

## 12. Stable identity and one ranking implementation

A supported harness reuses its saved default identity in a project across sessions;
session markers do not become new permanent agents or prove live presence. Keep
explicit legacy entries safe and conflicts visible. See
[stable harness identity](design/stable-harness-identity.md).

The [native-only retirement contract](design/native-ranking-only.md) requires
removing the independent TypeScript scheduler and all selection/rollback knobs,
without aliases or silent fallback. Neutral TypeScript mechanics remain.
[Markdown rules](design/markdown-rules.md) uses one generated English renderer for
CLI and onboarding snapshots while preserving native policy and structured JSON.

## Reading map

- [Research index and evidence](research/README.md): reasons, experiments and limits.
- [Feature contracts](design/README.md): subsystem-specific details and handoffs.
- [Agent workflow](agent-workflow.md): intake, commands, validation, review and delivery.
- [Source layout](design/source-layout.md): canonical ownership areas and imports.
