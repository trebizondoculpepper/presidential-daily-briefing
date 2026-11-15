# Dashboard navigation and evidence-based pipeline metrics

Status: proposed contract for #573. Nothing in this document is implemented by it. Sections headed "Shipped today" describe current behaviour and cite the file that implements it; every other section is a proposal for the named page tickets. Merging this document does not close #574, #575, #576, #456, #458, #548 or #605.

## Contents

- [Scope and owner decisions](#scope-and-owner-decisions)
- [Shipped today](#shipped-today)
- [Page map and shared shell](#page-map-and-shared-shell)
- [Evidence rules](#evidence-rules)
- [Event ledger: sources and historical feasibility](#event-ledger-sources-and-historical-feasibility)
- [Common definitions](#common-definitions)
- [Metric definitions](#metric-definitions)
- [Flow (Sankey) contract](#flow-sankey-contract)
- [Typed services and API](#typed-services-and-api)
- [Reads, cache and budgets](#reads-cache-and-budgets)
- [Chart and drill-down contract](#chart-and-drill-down-contract)
- [Implementation slices](#implementation-slices)
- [Open questions for the owner](#open-questions-for-the-owner)

## Scope and owner decisions

The owner approved five main pages (Overview/News, Work, Pipeline health, Timing, Agents) and utility pages (Quotas, Rules, Setup, and since #589 Settings and Diagnostics), all sharing one project selection, one navigation, one freshness model and the existing ticket/PR drill-downs, with no separate collector or ranker per page. The owner then fixed these page defaults in comments on #573, #574–#576 and #456, which this contract adopts without reopening:

- Overview news windows: 6 hours by default, 1 hour as the alternative.
- Throughput windows: 7 days by default, 30 days as the alternative.
- The flow (Sankey) cohort is selected by ticket creation date range; the full current backlog is a separate view, never mixed into the cohort.
- Timing is median-first, with mean and sample count beside it and drill-down to the tickets and dates behind each figure.
- A configurable "no recorded progress" section, 24 hours by default, which separates known waits from silence.
- #456 participation uses a selectable 1–7 day activity window, not stalled-ownership inclusion.
- Active agent CPU or work time is not required and is not measured.
- No numeric productivity weights for T-shirt sizes.

## Shipped today

Everything in this section exists on `origin/main` at 62c144c.

### Pages and routes

| Route                                                                                                                                       | What it is                                                  | Source                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `/` with `repo`, `role`, `agent`                                                                                                            | Role to-do list from the shared ranking                     | `src/serve/dashboard.ts`, routed in `src/serve.ts` (`dashboardFiles`) |
| `/ticket` with `repo`, `n`, `agent`                                                                                                         | Consolidated ticket and delivery detail (#454)              | `src/serve/ticket-page.ts` (`ticketPageParameters`)                   |
| `/setup`                                                                                                                                    | Agent setup prompts, no GitHub read (#391)                  | `src/serve/setup-page.ts`                                             |
| `/rules`                                                                                                                                    | English rendering of compiled policy, no GitHub read (#392) | `src/serve/rules-page.ts`                                             |
| `/api/v1/status`, `/healthz`                                                                                                                | Server status                                               | `src/serve.ts`                                                        |
| `/api/v1/briefing`, `/api/v1/team`, `/api/v1/tickets/N`, `/api/v1/issues/N`, `/api/v1/prs/N` (with `/deps`, `/who`), `POST /api/v1/refresh` | `serve-read` JSON envelope                                  | `src/serve/api.ts`                                                    |
| `/api/v1/diagnostics/*`                                                                                                                     | Safe internal-state inspection (#459)                       | `src/serve/diagnostics.ts`                                            |
| `/mcp`                                                                                                                                      | HTTP MCP                                                    | `src/serve/mcp.ts`, routed in `src/serve/services.ts`                 |

There is no Quotas page: the quota service and `pdb quotas` exist (`src/github/quotas.ts`, `src/github/quotascli.ts`), while the serve page is #548, still open. The `/activity` and `/human` routes in [serve-dashboard-read-views.md](serve-dashboard-read-views.md) are proposed, not shipped (#456 and #458 are open).

### Navigation is duplicated today

Each page builds its own header: the dashboard has a project `<select>` plus links to Rules and Setup (`src/serve/dashboard.ts`, `dashboardPage`); Setup has a `<nav>` with Dashboard, Rules and a project list (`src/serve/setup-page.ts`); Rules has a `<nav>` with Dashboard and a project list (`src/serve/rules-page.ts`); the ticket page has only a "Back to the to-do list" link (`src/serve/ticket-page.ts`). There is no shared shell. #605 replaces these with one component.

### Security boundary

Every HTML, CSS and script response carries `dashboardSecurityPolicy` (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), `cache-control: no-store`, `nosniff` and `referrer-policy: no-referrer` (`src/serve/dashboard.ts`, `src/serve.ts`). Pages have no inline script or style; browser scripts are self-contained renderers tested in isolation (`src/serve/dashboard.ts` header comment). Source text goes through `escapeHtml` (`src/serve/dashboard.ts`). Page routes accept only their declared query parameters and reject others with `INVALID_ARGUMENT` (`src/serve.ts`). Requests pass a DNS-rebinding guard before routing (`src/serve/http.ts`). Repositories outside the served allowlist are refused with `REPOSITORY_NOT_SERVED` (`selectRepository` in `src/serve/api.ts`).

### Cache, freshness and quota handling

One in-memory cache of whole collected results keyed by auth context, repository, collector and coverage; TTL freshness, coalesced identical reads with reference-counted abort, at most four concurrent collections, 256 entries / 64 MiB LRU, stale serving for up to 30 minutes only after a failed live read, nothing persisted and no background collection (`src/serve/cache.ts`). A quota refusal starts a shared cooldown, and partial or quota-stopped results are never stored as answers (`noteQuotaRefusal` uses in `src/serve/api.ts`). The quota service reads one `GET /rate_limit`, keeps missing evidence as null, never sums buckets and never attributes account usage to a repository (`src/github/quotas.ts`).

### Evidence the code already reads

| Evidence                                                                  | What exists                                                                                                                                                                                                                                                                                                                                                                         | Source                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Issue and PR identity, `createdAt`, `closedAt`, `stateReason`, `mergedAt` | Collected fields                                                                                                                                                                                                                                                                                                                                                                    | `src/github/github.ts`, `src/github/types.d.ts`                                          |
| Changed-since evidence                                                    | Half-open UTC window `[from, through)`; all-state issues and PRs walked by `UPDATED_AT` descending, 50 per page, default cap 20 pages per source; per-source `SourceCoverage` with `complete`, `pages`, `omission`; events `created`, `merged`, `closed`, `closed-unmerged`; retained claim/release marker operations; scope explicitly excludes `transient-label-or-state-history` | `src/github/changes.ts`                                                                  |
| Repository catch-up                                                       | Sections activity, progress, completed, blockers, attention; `HistoryStatus` complete / incomplete / unavailable / baseline; completed split by `stateReason === "COMPLETED"`                                                                                                                                                                                                       | `src/briefing/catchup.ts`, MCP rendering in `src/mcp/views.ts`                           |
| Claims and releases                                                       | `github-triage:claim:<hash>` and `github-triage:release:<hash> {json}` marker comments with `createdAt`; claim-start time from `LABELED_EVENT`/`UNLABELED_EVENT` timeline of the `agent:` label, bounded to 3 extra pages (`claimHistoryPages`) and reported `complete: false` when cut off                                                                                         | `src/workflow/claims.ts`                                                                 |
| Claim activity and waits                                                  | Active / waiting / unknown fold over claim-activity records (#412)                                                                                                                                                                                                                                                                                                                  | `src/workflow/claimactivity.ts`, `src/workflow/retained.ts`                              |
| Delivery records                                                          | `github-triage:delivery v1` ops (`submit`, `attach`, `detach`, `retarget`, `handoff`, `membership`, `attest`, `complete`, `reassign`, `reset`, `void`, legacy ops) folded in order through a trust decision; unknown records are `recordsUnknown`, never absence                                                                                                                    | `src/workflow/delivery.ts`                                                               |
| Verified delivery                                                         | Live evidence per required member; verdict precedence unknown > delivered > attested > partial > submitted > legacy > none; `complete` writes only on a fresh delivered or applicable attested verdict                                                                                                                                                                              | `src/workflow/completion.ts`                                                             |
| Assessments                                                               | `complexity-estimate` and `impact-estimate` provenance comments with `size`, `previous`, `recordedAt`, `guidanceVersion`, estimator; trusted reading states `current`, `stale`, `unassessed`, `conflict`, `invalid`, `unknown`, `disabled`; labels are the size authority                                                                                                           | `src/estimation/estimate.ts`, `src/estimation/metrics.ts`, `src/briefing/assessments.ts` |
| Team                                                                      | Ownership from `agent:` labels only, never the shared GitHub login; presence always unknown; default stale threshold 48 hours                                                                                                                                                                                                                                                       | `src/workflow/team.ts`                                                                   |
| Native dependencies                                                       | `blockedBy` / `blocking` current state                                                                                                                                                                                                                                                                                                                                              | `src/github/dependencies.ts`                                                             |

What does not exist: any per-ticket history ledger across tickets, any day-bucketed aggregate, any historical label or blocked-state history (the change scope excludes it on purpose), any metric API, and any persistence. Historical blocked/ready durations are therefore not available from current sources; see the feasibility table.

## Page map and shared shell

Proposed. One shell (#605) renders the toolbar on every HTML page; pages differ only in their main region.

| Page                  | Route                                                            | Data                                      | Ticket                                      |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Overview / News       | `/overview?repo=R&news=6h&days=7d`                               | Event ledger, window aggregates           | #574                                        |
| Work                  | `/?repo=R&role=…&agent=…` (existing), human view `/human?repo=R` | Existing briefing projections             | #374 (shipped), #458                        |
| Pipeline health       | `/pipeline?repo=R&from=YYYY-MM-DD&through=YYYY-MM-DD`            | Ledger cohort flow plus current inventory | #575                                        |
| Timing                | `/timing?repo=R&days=7d`                                         | Ledger durations                          | #576                                        |
| Agents                | `/activity?repo=R&window=1d`                                     | `/api/v1/team` plus ledger activity       | #456                                        |
| Quotas (utility)      | `/quotas` (account-scoped, no `repo`)                            | Quota service                             | #548                                        |
| Rules (utility)       | `/rules?repo=R` (existing)                                       | Compiled policy                           | shipped                                     |
| Setup (utility)       | `/setup?repo=R` (existing)                                       | Local only                                | shipped                                     |
| Settings (utility)    | `/settings?repo=R`; no `repo` means Global                       | Settings service                          | #584, [contract](serve-settings-page.md)    |
| Diagnostics (utility) | `/diagnostics?repo=R&tab=doctor\|ticket-doctor`                  | Doctor and Ticket Doctor runs             | #585, [contract](serve-diagnostics-page.md) |
| Ticket detail         | `/ticket?repo=R&n=N` (existing)                                  | Ticket read                               | shipped                                     |

Shell rules that #605 implements and the page tickets consume:

1. The selected project lives only in the `repo` query parameter, validated through `selectRepository`. No cookie, local storage or server-side session holds it. A missing or unserved value shows the selector and a no-selection state; it never falls back to the server's working directory.
2. Every toolbar link carries the current `repo`, URL-encoded, and drops page-specific parameters. Ticket and PR drill-downs carry `repo` and `n`.
3. Quotas is account-scoped and says so; the toolbar shows "account-wide" instead of a project there, and the link to it carries no `repo`.
4. Rendering the toolbar performs no GitHub read. Only the visible page's main region reads, on load or on Refresh.
5. Switching project or window aborts the in-flight `fetch` and discards any late response by comparing a request generation with the current selection, as already required in [serve-dashboard-read-views.md](serve-dashboard-read-views.md).
6. Each new page route extends the `src/serve.ts` page allowlist with exactly its parameters, keeps `dashboardSecurityPolicy`, and ships its script as a same-origin file.

## Evidence rules

These restate the project's reliability principles as testable rules for every metric.

1. A figure is either computed from evidence observed during the current read, or it is reported as `unknown` with a reason. Missing evidence is never zero, never healthy and never "none".
2. Every metric result names its population, window, UTC day labels, observation time, coverage per source, sample count and the count of members whose value is unknown.
3. Completed-only statistics are always shown next to the count of unfinished and never-started members of the same cohort, so a short average cannot hide a long queue.
4. Delivery is verified delivery from `src/workflow/completion.ts`, not closure. GitHub `closed` with `stateReason: COMPLETED` is reported separately as "closed as completed"; `NOT_PLANNED` as "closed not planned"; PR merges as their own count. No series is derived from another.
5. Actor intent is never inferred from the shared GitHub login. Agent attribution comes only from `agent:` labels and structured records, as `src/workflow/team.ts` already does.
6. Current labels never silently rewrite history. Grouping by size or impact uses the value evidenced at the relevant instant (see [Historical size and impact](#historical-size-and-impact)), otherwise the member falls into an explicit "size unknown at event" group.
7. No invented deadlines or service levels. Ages are shown, not judged.

## Event ledger: sources and historical feasibility

The proposed core is one pure fold, `ticketLedger(issue, linkedPrs, records, now)`, that turns already-collected facts into a typed, ordered list of events per ticket. Every page computes from ledgers; no page parses comments.

| Event                                            | Source                                                                              | Historical feasibility                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `created`                                        | Issue `createdAt`                                                                   | Complete for any issue read.                                                                                                                                                                                                                                                                                                                                                                                             |
| `closed` with reason                             | Issue `closedAt`, `stateReason`                                                     | Latest closure only. GitHub's issue object keeps one `closedAt`; earlier close/reopen cycles need `ClosedEvent`/`ReopenedEvent` timeline items, which are not read today. Proposed: read them per issue in the same bounded timeline request as claim history, marking `complete: false` when cut off.                                                                                                                   |
| `reopened`                                       | Timeline `ReopenedEvent`                                                            | Not read today; same proposal as above. Until shipped, reopen count is `unknown`, not zero.                                                                                                                                                                                                                                                                                                                              |
| `assessed` (per metric)                          | Trusted provenance comments with `recordedAt`, `size`, `previous`                   | Feasible with hydration: the open-issue snapshot pages comments in full (`collect` in `src/github/github.ts`), but the change-evidence walk reads only `comments(first:100)` (`boundedChanges` inside `collect`), so closed historical tickets need the bounded hydration in [Reads, cache and budgets](#reads-cache-and-budgets). A label without trusted provenance has a current size but an unknown assessment time. |
| `picked-up`                                      | Claim marker comment `createdAt`, and the `agent:` label add time from the timeline | Feasible but bounded: claim history is cut off after 3 extra timeline pages (`src/workflow/claims.ts`). Hand-added labels without a marker count as pickups, flagged `source: label`.                                                                                                                                                                                                                                    |
| `released` / `requeued`                          | Release marker records                                                              | Feasible from comments.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `waiting` / `resumed`                            | Claim-activity records (#412)                                                       | Feasible from comments for tickets that use them; earlier tickets are `unknown`.                                                                                                                                                                                                                                                                                                                                         |
| `submitted`, `membership`, `handoff`, `complete` | Delivery records                                                                    | Feasible from comments through the trust fold.                                                                                                                                                                                                                                                                                                                                                                           |
| `pr-merged` per required member                  | PR `mergedAt` for members of the folded required set                                | Feasible, one targeted read per required PR, as completion already does.                                                                                                                                                                                                                                                                                                                                                 |
| `delivered`                                      | Completion verdict                                                                  | Current verdict only. The instant is the latest required-member merge, provided the verdict is `delivered` now.                                                                                                                                                                                                                                                                                                          |
| `blocked` / `unblocked`                          | Native dependencies                                                                 | Current state only. GitHub exposes no blocked-by history through the sources used here, so historical blocked time is not computable. Pages show current blocked inventory and ages since the ticket's last observed change, never historical blocked durations.                                                                                                                                                         |
| Label history (impact, complexity, urgency)      | Timeline label events                                                               | Not read today, excluded from change scope. Assessment history uses provenance records instead.                                                                                                                                                                                                                                                                                                                          |

Every ledger carries `coverage: { comments, timeline, deliveryRecords, prs }`, each `complete | partial | unavailable`, and a list of omissions. A metric that needs a partial source excludes the ticket from its sample and counts it under "history incomplete".

## Common definitions

### Population and cohort

- **Cohort** is the set of tickets an aggregate is computed over. Every result names its cohort rule. Two rules exist: `created-in(from, through)` (tickets whose `createdAt` falls in the UTC date range) and `event-in(type, from, through)` (tickets with at least one event of that type in the window).
- **Current inventory** is open issues observed now. It is never presented as a historical flow.
- Pull requests are not tickets. PR merges are a separate count unit, never mixed into ticket counts.

### Days, windows and partial days

- Calendar days are UTC days, labelled `YYYY-MM-DD (UTC)`. No local-time bucketing.
- A trailing window `7d` is the last seven complete UTC days plus the current partial day shown separately, marked "partial, observed through HH:MM UTC". The partial day is never included in a daily average.
- A day with complete coverage and no events is a zero-event day and counts as 0 in averages. A day with incomplete coverage is `unknown` and is excluded from the average, which then reports "average over N of 7 days; M days unknown".
- Rolling news windows (`1h`, `6h`) are half-open `[now − w, now)`, reusing `resolveWindow` and `inWindow` from `src/github/changes.ts`.

### Deduplication and identity

- A ticket is counted once per cohort, keyed by repository and issue number.
- An event is keyed by its source identity (comment `databaseId`, review URL, or `(issue, event type, timestamp)` for issue fields). The same comment seen through two reads is one event.
- Records are ordered by `createdAt` then comment `databaseId`, as the delivery fold already orders them (`src/workflow/delivery.ts`); an edit does not move a record.

### Pickup, handoff, release and reclaim

- **First valid pickup** is the earliest `picked-up` event that the claim rules accept (a claim marker, or an `agent:` label add, by a trusted actor). See open question 1.
- A handoff (`handoff` delivery record or a reassignment) never resets the pickup clock.
- A release followed by a later claim is a **requeue**. The original first pickup is kept; the ticket is flagged `requeued: true` with a count.
- A ticket with no pickup ever is **never picked up**; a ticket whose last pickup was released and not reclaimed is **released**.

### Completion, membership and multiple PRs

- **Delivered** means the completion verdict is `delivered` (or `attested`, shown separately) now. The delivery instant depends on the required set:
  - PR members only: the latest `mergedAt` across required members of the folded set.
  - Any commit member (`collectDeliveryFacts` in `src/workflow/completion.ts` verifies commits by target containment, which carries no reliable "became contained" time): the instant is `unknown`.
  - Attestation over an empty complete required set (accepted by `evaluateDelivery`): the `createdAt` of the trusted `attest` record, labelled "attested at", never "merged at".
  - A ticket whose instant is `unknown` still counts in the current outcome and in the Sankey, but is excluded from dated series and timing samples and counted there as "delivered, date unknown". No timestamp is invented, for example from `closedAt`.
- A ticket with several required PRs counts once as delivered, at the last required merge. Each merged PR still counts once in the PR-merge series.
- Membership `open` means the required set is not final; such a ticket is "in delivery", not delivered, even if every current member merged.
- **Abandoned** means closed `NOT_PLANNED`, or closed with a `void`/`reset` delivery outcome and no later pickup.
- **Closed as completed without verified delivery** is its own outcome: never counted as delivered.
- **Unknown** means the verdict is `unknown` or the ledger lacks the evidence to classify.

### Reopened tickets

A reopened ticket stays one ticket. Its outcome is its current outcome. Earlier closures are listed in its drill-down and counted in a separate "reopened" figure, once timeline closure events are read (see the feasibility table).

### Historical size and impact

The size of a ticket at instant `t` is the `size` of the newest trusted provenance record with `recordedAt ≤ t`. When the current label has no trusted provenance at or before `t`, the size at `t` is `unknown at event`. A current label is never projected backwards. Results show the "unknown at event" group with its count.

## Metric definitions

All examples are synthetic.

### Overview / News (#574)

- **News**: the ledger events in `[now − 6h, now)` (or `1h`), newest first, each linking to its ticket or PR. Event kinds: created, picked up, released, submitted, PR merged, delivered, closed as completed, closed not planned, assessed. Coverage incomplete shows "events before HH:MM UTC may be missing".
- **Daily series** per UTC day: verified deliveries (tickets), closed-as-completed-unverified (tickets), closed not planned (tickets), PR merges (PRs). Four separate series, never stacked into one total.
- **7-/30-day daily average** per series over complete days only, with N of 7 days known.
- **Breakdown by complexity** of verified deliveries, using size at the delivery instant, with "unassessed" and "unknown at event" as their own bars.

Example: on 2026-11-10 (UTC) tickets #1 and #2 reach `delivered`, #3 closes `COMPLETED` with verdict `none`, and PRs #10, #11 and #12 merge (#10 and #11 both belong to #1). The day shows deliveries 2, closed-as-completed-unverified 1, not planned 0, PR merges 3. Clicking deliveries lists #1 (members #10, #11) and #2.

### Work (#374, #458)

Reuses the existing briefing projections unchanged; no new metric. The shell adds only navigation.

### Pipeline health (#575)

- **Current inventory** of open tickets by stage: unassessed (either metric `unassessed`), ready, blocked, claimed, in review / submitted, with count, median age and oldest age per stage. Age is time since `created` for unassessed and ready; since first valid pickup for claimed. Unknown ages are counted, not dropped.
- **Backlog by impact**: open unclaimed tickets by current impact, split ready versus blocked/not-ready, with unassessed separate. Current inventory uses current labels; this is not historical.
- **Assessment queue**, per metric: count unassessed, median and oldest age, first-assessment latency (created to earliest trusted record) for the cohort, revision count (records with non-empty `previous`), and counts in `stale`, `conflict`, `invalid`, `unknown`. Incoming (created in window) versus first-assessed (in window) per day reveals growth without any deadline.
- **Flow**: see the Sankey contract.
- **Stalled work** (owner default 24h, configurable; placed here by the owner's #456 clarification, not on Overview): claimed tickets with no ledger event in the window, split into "known wait" (claim-activity `waiting`), "blocked" (native) and "no recorded event". This section, not the Agents page, is where owners without recent participation appear. Text says "no recorded progress", never "inactive" or "abandoned".

### Timing (#576)

Each duration metric reports median, mean, count completed, count still open (with their current elapsed time as a lower bound) and count with unknown endpoints. Percentiles (p75, p90) appear only when the completed sample is at least 20 (see open question 4).

- **Pickup to delivery** by complexity at pickup (see open question 2): first valid pickup to latest required merge, for tickets delivered in the window. Reviews and waits are included; handoffs and requeues never restart it.
- **Creation to first pickup** by impact at pickup, for tickets first picked up in the window, plus never-picked-up open tickets created in the window with their current age.
- **Creation to first assessment**, separately for impact and complexity, for tickets first assessed in the window, plus still-unassessed tickets.
- Requeued, reopened and currently blocked tickets are flagged in drill-downs and counted in a footnote, not silently removed.

Example: sizes S: tickets A (pickup to merge 4h), B (10h), C (still open, 30h so far). Display: "S: median 7h, mean 7h, 2 delivered, 1 still open (≥ 30h), 0 unknown".

### Agents (#456)

As specified in [serve-dashboard-read-views.md](serve-dashboard-read-views.md), with the owner's 1–7 day activity window: an agent is listed when it holds a claim or has a ledger event attributed through records or `agent:` labels in the window. Presence remains unknown.

## Flow (Sankey) contract

- **Cohort**: `created-in(from, through)` in UTC dates. **Count unit**: tickets. Each ticket contributes exactly one path.
- **Stages**: created → assessed (both metrics trusted, or "partially assessed", or "unassessed") → picked up / never picked up → outcome.
- **Outcomes**: delivered, attested, closed as completed (unverified), closed not planned / abandoned, open in delivery, open claimed, open unclaimed, unknown.
- **Conservation**: the sum of outcome counts equals the cohort size. A test asserts it for every fixture.
- **Rework**: a requeued or reopened ticket still follows one path, using its first pickup and its current outcome. Repeated transitions are shown as an annotation ("3 tickets requeued, 1 reopened"), never as extra flow width.
- **Unknown** is a visible node, never folded into another.
- A **table fallback** lists the same nodes and links with counts; every node and link drills down to its tickets.
- The current-inventory view is labelled "now" and is never drawn as a flow.

Example: cohort 2026-11-01..2026-11-07 has 10 tickets. 8 assessed, 1 partially, 1 unassessed; 6 picked up, 4 never; outcomes delivered 4, closed-as-completed 1, abandoned 1, open unclaimed 3, unknown 1 (history incomplete). 4+1+1+3+1 = 10.

## Typed services and API

Proposed modules, each pure over injected facts:

- `src/metrics/ledger.ts`: `ticketLedger` and `LedgerEvent`, `LedgerCoverage` types. Reuses the parsers in `src/workflow/delivery.ts`, `src/workflow/claims.ts`, `src/workflow/claimactivity.ts`, `src/estimation/estimate.ts` and `src/github/changes.ts`; adds none of its own.
- `src/metrics/windows.ts`: UTC day bucketing, complete/partial/unknown day classification, averages.
- `src/metrics/aggregate.ts`: cohort selection, series, duration statistics with sample thresholds, flow with conservation.
- `src/metrics/read.ts`: the bounded collection described below, through the existing `ServeReadRuntime` boundary and `ServeCache`.

One read endpoint, `GET /api/v1/metrics?repo=R&view=news|daily|flow|timing|inventory&…`, returns the existing `serve-read` envelope with `result: { schemaVersion: 1, kind: "pipeline-metrics", view, cohort, window, days, coverage, figures, members }`, where every figure carries `value | null`, `unknownReason`, `sample`, and the member ticket numbers that make it up (bounded, with an omitted count). Drill-down uses those members, so displayed totals and drill-down membership cannot disagree. The CLI and MCP may later expose the same result; no parity is required for the first page slices.

## Reads, cache and budgets

- Lazy only: a metrics read starts when a page asks. No timers, prefetch or background refresh, as `src/serve/cache.ts` already enforces.
- Two populations, two reads. **Current state** (inventory, backlog, assessment queue, no-recorded-progress, open members of a cohort) reuses the full open-issue snapshot from `collect` in `src/github/github.ts`, the same one the briefing uses, because quiet open tickets are exactly the ones a window walk would miss. **Historical events** reuse the change-evidence walk (`src/github/changes.ts`): all-state issues and PRs by `UPDATED_AT` descending until `updatedAt < window start`. Any ticket created or closed in the window has `updatedAt` inside it, so the walk covers those events without a full-repository read. The existing page cap applies; hitting it marks historical coverage partial, never current inventory.
- Comments: the open snapshot already pages comments in full. The change walk does not: `boundedChanges` inside `collect` in `src/github/github.ts` reads `comments(first:100)` and passes those nodes on. A historical ticket whose comment connection has more pages is hydrated by the same per-item comment pagination the snapshot uses, bounded per request (proposed: 50 tickets, 10 extra pages each); a ticket not fully hydrated has `coverage.comments: partial` and is excluded from samples needing its records and counted as "history incomplete". Timeline reads for claim and closure history are bounded per ticket (today 3 extra pages) and per request (proposed cap: 100 tickets per metric read, the rest counted as "history not read").
- Results are cached in the existing `ServeCache` under a new collector key that includes the window, so 7-day and 30-day reads are separate entries and identical concurrent reads coalesce. Partial or quota-stopped results are never stored as answers, as today.
- Refresh uses the existing `POST /api/v1/refresh`. Switching view cancels the abandoned read.
- No new credentials, no private transcripts, no inbox or telemetry scraping.

## Chart and drill-down contract

- Every chart has a semantic table with the same numbers, reachable without a pointer, and a text summary in an `aria-live` status region.
- Bars and Sankey are inline SVG generated by the same-origin script; no external library or font, consistent with `dashboardSecurityPolicy`.
- Unknown and partial values are drawn with a distinct pattern and labelled in text, never as zero-height bars.
- Each bar, node, link and table row is a keyboard-focusable link to a drill-down listing its member tickets (title escaped, link to `/ticket?repo=R&n=N`) and the evidence events that placed them there.
- Colour is never the only carrier of meaning; labels sit beside every series.
- Narrow screens show the table first and the chart second.

## Implementation slices

Each slice is one focused PR, after this document merges.

1. **Shared shell and toolbar (#605).** One toolbar component used by `/`, `/ticket`, `/setup` and `/rules`; `repo` propagation; account-scope labelling slot for Quotas. Checks: every page renders the same toolbar with the active page marked; links preserve `repo`; unserved or malformed `repo` shows the no-selection state without a GitHub call; rendering the toolbar makes no collection call; CSP and parameter allowlists unchanged; keyboard and narrow-width tests.
2. **Ledger fold.** `src/metrics/ledger.ts` with synthetic fixtures. Checks: claim, release, requeue, handoff, multi-PR, membership open, reopen-unknown, untrusted records, edited records, duplicate comments; coverage partial when a source is cut off; no GitHub access in the module.
3. **Closure and claim timeline read.** Extend the bounded per-ticket timeline read with `ClosedEvent`/`ReopenedEvent`. Checks: bounds respected, `complete: false` on cut-off, reopen counts unknown before this slice and known after.
4. **Windows and aggregates.** `src/metrics/windows.ts`, `src/metrics/aggregate.ts`. Checks: UTC boundaries at 23:59:59.999 and 00:00, partial day excluded from averages, zero-event versus unknown days, percentile threshold, conservation for every flow fixture, size-at-event grouping with "unknown at event".
5. **Metrics API.** `GET /api/v1/metrics` with cache key, cancellation, refresh and budgets. Checks: envelope shape, figures agree with members, unserved repo refused, quota-stopped result not cached, coalescing of identical reads, no background requests.
6. **Overview page (#574).** Checks: four separate series, 6h/1h news, 7d/30d averages, drill-downs, empty/partial/error states.
7. **Pipeline health page (#575).** Checks: inventory versus cohort separation, Sankey plus table, conservation visible, assessment queue states, stalled-work split.
8. **Timing page (#576).** Checks: median-first display with mean and counts, open and unknown counts, handoff does not restart, impact/complexity at event.
9. **Agents page (#456)** and **Human page (#458)** proceed under [serve-dashboard-read-views.md](serve-dashboard-read-views.md), adopting the shell from slice 1 and the 1–7 day window. **Quotas page (#548)** proceeds under [github-quotas.md](github-quotas.md).

Slice 1 depends on nothing here beyond the page map. Slices 2 to 5 are sequential. Slices 6 to 8 each need slice 5 and are independent of each other.

## Open questions for the owner

These need an owner decision. Each has a proposed default that implementers must not adopt until answered.

1. **What counts as the first valid pickup?** Options: (a) only a `pdb claim` marker comment; (b) the earliest of a claim marker and an `agent:` label add by a trusted actor. Proposed default: (b), with the source shown, because older tickets predate markers.
2. **Which size groups pickup-to-delivery timing?** The ticket requires evidence "as of the relevant event", but this metric spans two events and sizes can be revised between them. Options: size at first pickup; size at delivery; the latest size recorded before pickup, else "unknown at event". Proposed default: size at first pickup.
3. **How far back may a metrics read go?** 30 days of all-state history with per-ticket timeline reads may be expensive on busy repositories. Options: cap at 30 days with partial coverage beyond the request budget; or allow longer cohort ranges for the Sankey with an explicit "partial" result. Proposed default: 30 days maximum for all pages, including the Sankey cohort range.
4. **Minimum sample for percentiles.** The ticket asks for percentiles only with sufficient samples but sets no number. Proposed default: 20 completed members.
