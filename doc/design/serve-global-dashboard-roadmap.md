# Serve: registration, lazy data and user-facing slices

Owner decisions, 2026-11-15, for #42, #443 and #452–#459. This is a
documentation-first roadmap, not a claim that the new behavior is installed.
Where requirements differ from the initial serve contract, these later decisions
define the target behavior; implementation and detailed schema review follow in
the linked tickets. Preserve the shared collector, ranker, command services and
current access boundaries rather than creating another workflow model.

## Startup and persistent configuration

First `pdb serve` initializes global per-user TOML defaults, including a localhost
port and registered projects. Extend `pdb config` with explicit global scope;
keep repository settings and per-project agent identities separate. Configuration
persists; collected GitHub data does not. Do not store credentials in this file.

Resolve supplied repositories/project paths, the current verified Git repository
(also from a subdirectory), and saved projects. Automatically register explicit
and current projects, deduplicate them, and include previously saved projects on
future launches from any directory. Do not guess a repository from its directory
name or an ambiguous remote. If no projects are available, print useful guidance
and exit without starting an empty service.

Run one service per user by default. A second invocation updates project
registration, causes the compatible existing service to observe the additions,
prints that PDB is already running and its actual URL, then exits. Never open a
browser or attach a UI/session automatically. Finalize verified instance discovery,
safe concurrent configuration/startup, stale discovery handling and configured-port
changes in #443 before #452 implementation. An unrelated listener is not PDB.

## Strictly lazy data

No collection at startup, registration, idle time or background expiry. A requested
view fetches the facts it needs; simultaneous compatible requests share the fetch.
Use the existing five-minute initial TTL, configurable toward ten minutes. Once
expired, the next request waits for a fresh fetch; the web view can show loading.
Keep source observation times, evidence coverage and incomplete results explicit.

The initial selective cache focuses on issue title/body/state/labels/native
dependency facts, not eager comment history. Load comments for focused detail or
when a rule requires comment-backed evidence. Unloaded comments never establish
that no question, ownership record or decision exists. Reuse discovery/hydration
profiles and identify unknown evidence honestly; do not bypass provenance checks
to reduce requests. #453 reconciles this with existing shared-cache behavior.

Preserve repository/authentication/profile isolation and derive each caller's
role/name/platform projection correctly. Shared issue facts are not a shared
personalized queue. Do not cache independent pages or persist fetched data across
restart. Successful writes through the service invalidate affected issue and
derived queue/dependency views; uncertain write outcomes require conservative
invalidation too. Independent CLI/external writes use TTL/manual refresh unless
an actual notification path has been implemented. Never promise instant
cross-process invalidation merely because both clients are PDB.

## Minimal MCP and early diagnostics

Reuse the implemented/in-review HTTP MCP transport under #373; #390 audits and
completes the missing useful briefing capabilities rather than rebuilding it.
Initial role set: implementer, designer and human. Agent requests carry project,
role, reported agent name and platform. Tailor owned work, addressed requests and
platform eligibility through shared rules. Report missing/ambiguous focus instead
of borrowing identities; reported identity is not authorization.

Human briefings use the shared attention projection #457. Full CLI/MCP parity is
a future goal, not a prerequisite. Keep existing supported tools compatible.
Connection itself does not fetch every repository.

#459 is an early follow-up after this minimum, ahead of editing and full parity.
Expose read-only diagnostic JSON over documented REST URLs, extending existing
status views: registered projects, effective nonsecret settings, cache age and
coverage, in-flight work, bounded sanitized errors, and rule identity/diagnostics.
An agent can inspect these with curl even if MCP lacks the equivalent tool.
Inspect existing state without triggering collection. Define allowlisted schemas,
bounded lists and access behavior, not a raw memory dump. Exclude credentials,
tokens, sensitive headers and unrestricted local error/path content.

Keep existing `/healthz` independent: 200 while accepting requests, 503 during
shutdown, no GitHub requests. Dependency access/freshness is diagnostic state,
not process liveness. A health endpoint permits future containerization; Docker
packaging has not been added to this delivery.

## Dashboard slices

The first dashboard (#374) is read-only. Select a project and role, then show one
ranked to-do list with a small header, reasons and useful commands/detail links.
Render progressively if useful, but visibly distinguish loading, provisional
order and incomplete evidence from a completed shared ranking result. No separate
UI priority algorithm or independent polling loop.

Focused follow-ups reuse services:

- #454: consolidated ticket details, including relevant discussion, linked PRs,
  checks/reviews, delivery state, blockers, responsibility and next action.
- #456: agent activity by project, reusing team/who. Show claimed work, submitted
  obligations, waits and latest recorded activity. Do not equate silence with
  offline status or abandonment.
- #457: shared human attention/briefing projection. Show actual questions,
  decisions, approvals and reviews/sign-offs needed from the human, including why,
  what is blocked and a focused source link. Separate explicit requests from
  inferred candidates. Reuse existing trusted records and #414's closed-source
  question work instead of inferring resolution from a merge or arbitrary reply.
- #458: read-only human attention page consuming that same projection; answering
  and signing off from the UI is later scope.
- #455: later editing of complexity, impact and existing urgency labels. Reuse
  validation, rationale/provenance and mutation services. A reviewed mutation/access
  contract precedes the expansion of the read-only HTTP surface. No new importance
  score, automatic claims or automatic completion.

The connection/setup page #391 provides minimal tested configuration and usage
prompts, reusing onboarding work. The rules page #392 renders all represented
active project policy in English from the native Datalog artifact and effective
settings. Share the renderer with `pdb rules` (#416): conditions, effects,
precedence and reasons, with explicit coverage gaps. It is not a separately
maintained manual or a summary of only the rules that matched one ticket.

## Readiness and verification

#443 can begin the settled startup/config design; #374 can begin the read-only
UI contract and #457 the shared human projection contract. These are
documentation-first tasks, not permission to skip contracts or native blockers.
Independent implementation follows reviewed interfaces. Existing #373 ownership
and open PRs must be respected when adjusting shared cache/transport modules.

Use synthetic temporary Git repositories, clocks, collectors and identity fixtures.
Test registration and concurrent reuse, no-project exit, config isolation, zero
startup queries, expired/coalesced reads, comment-required unknowns, persona
isolation, projection parity, bounded diagnostics with no secret output, and
read-only versus later mutation behavior. Keep versions and freshness visible;
measure request reuse rather than claim a speedup without evidence.
