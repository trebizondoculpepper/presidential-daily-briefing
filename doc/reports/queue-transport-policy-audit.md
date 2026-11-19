# Queues, shortlist and transports: workflow policy outside native rules (#699)

Focused child of #680, companion to the [claim and delivery audit](claim-delivery-policy-audit.md) (#698). Source audit at commit `4c637f80`, after the TypeScript ranker was retired (#1050): the native engine is the only ranker and `briefing.engine` is a retired key. Read-only; nothing was built or run against live data.

Classification: **(a)** workflow policy outside native rules; **(b)** deterministic projection, aggregation, validation or collection mechanics; **(c)** ambiguous.

**Coverage is partial**, and the gaps are named rather than guessed: see "Not audited".

## Confirmed divergence: `--section` re-ranks with TypeScript policy

The native role view carries only the `other-context` section (`compact.ts:365-389`). For any other section ID, `--section` resolves through `roleView()` (`compact.ts:551-557`), whose selectors in `roles.ts:216-306` filter and sort with TypeScript policy:

- `pickup` uses `rankPickup` (`briefing.ts:700`);
- design pickup uses `compareImpact`, then `compareCreatedAt`, then number;
- PR follow-up uses mine-first, then priority;
- decision-needed uses holds-count.

These surfaces accept the section IDs that reach this fallback: CLI `--section`, MCP section input, and HTTP `section=` (validated against `roleSectionIds`, `api.ts:918-924`). A focused section can therefore show a different membership and order from NEXT STEPS for the same request, ignoring native denials, retained claims and project rules. Filed separately (see "Follow-up").

## 1. Candidate membership

| #   | Where                                               | Decision                                                                                                                              | Class   | Native owner                                                |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| 1.1 | `src/mcp/polling.ts:200-219`                        | `work-became-eligible` is decided by TypeScript `pickupEligibility(issue, { prs })`, without platform, owned-claims or retained facts | **(a)** | Native pickup eligibility; no event projection exists (gap) |
| 1.2 | `src/briefing/service.ts:192,265,390`               | Human role goes to `presentHuman`; `--full`/`--issue` skip native evaluation (intake scope)                                           | (b)/(c) | — (see 3.4)                                                 |
| 1.3 | `src/briefing/compact.ts:198-208, 411-419, 493-500` | `--label` scopes the native ranking after evaluation, keeping order; truncated labels are unknown                                     | (b)     | —                                                           |
| 1.4 | `src/briefing/service.ts:716`                       | Shortlist skipped for `--issue`, `--since` and human                                                                                  | (b)     | —                                                           |

## 2. Shortlist, hydration and limits

| #   | Where                                      | Decision                                                                                                                | Class                                   | Native owner                       |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| 2.1 | `src/briefing/service.ts:947-957`          | Hydration budget for project-preferred items ordered by a TypeScript sort (max project priority, then implementer rank) | **(c)**                                 | Gap: no native hydration-order key |
| 2.2 | `service.ts:927-946`, `engine.ts:392`      | Role prefixes read from positional fields of the `RANK_PARTITION` string                                                | (b), with a fragile positional coupling | `ordering.edn` ranks               |
| 2.3 | `compact.ts:420-430`, `adapter.ts:510-511` | Display limit slices the native order; `omitted = total - shown`                                                        | (b)                                     | —                                  |

## 3. Priority and tie-breaks outside the engine

| #   | Where                                                             | Decision                                                                                                                                                                                                    | Class                           | Native owner                                    |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| 3.1 | `compact.ts:537-558`, `roles.ts:216-306`                          | `--section` fallback (above)                                                                                                                                                                                | **(a)**, confirmed              | `ordering.edn`; per-section membership is a gap |
| 3.2 | `compact.ts:263-295, 472, 528`                                    | A TypeScript tier sort decides "higher-priority work", which sets `estimation.offered` and the "estimation is offered below" text                                                                           | **(a)**                         | Gap: no native offer-estimation decision        |
| 3.3 | `briefing.ts:131-160, 612-618`, `ranking.ts:17-32, 309-375`       | TypeScript pickup eligibility and impact/oldest ranking still run on every briefing. They feed `subjects[].findings` ("Pickup rank N of M", shown under native rows) and JSON `sections.available`/`review` | **(a)**                         | Native eligibility and ordering                 |
| 3.4 | `compact.ts:442-447`, `service.ts:358-360`                        | Intake (`--issue`, `--full`) declares "not ranked" but prints TypeScript-ordered pickup and actions                                                                                                         | **(c)**                         | Gap, or drop the ordering                       |
| 3.5 | `dependencyimpact.ts:212,416,430`, `estimation/estimation.ts:367` | Call `pickupEligibility`/`rankPickup`                                                                                                                                                                       | (c), seen but not read in depth | —                                               |
| 3.6 | `src/briefing/human.ts:377-386`                                   | Fallback waiting/input section when the native item has no `attentionSection`                                                                                                                               | (c), low                        | `attentionSection` (#643)                       |
| 3.7 | `src/serve/human-page.ts:257-259`                                 | Splits on native `attentionSection`, keeping server order                                                                                                                                                   | (b)                             | —                                               |

## 4. TypeScript-rollback remnants

- `service.ts:378-387`: intake reports `decisionEngine.used: "typescript"`; nothing TypeScript ranks there. **(c)**: should be relabelled.
- `rebrief/core.ts:180, 375, 383`: the schema still accepts `used: "typescript"`, `missing-policy` is checked only for datalog, and `policyRevision` falls back to `"typescript"`. **(c)**, low risk, because a ranked report must carry `rankedActions`.
- `service.ts:266-267`: a stale comment. `compact.ts:393-400, 451-453` (reasons only, intake), `engine-setting.ts:12`, `serve/services.ts:337`. **(b)**

## 5. Rebrief

- `src/rebrief/core.ts:366-372`: the queue counts as empty when every item is `wait-claim` or lacks a next command and inspection. **(c)**: a TypeScript decision about what is actionable; there is no native "continuable" relation.
- The selection, freshness and queue-consistency checks, and the fingerprint inputs, are **(b)**.

## 6. Transports

- HTTP `src/serve/api.ts:933-950`: no `platform` reaches `readBriefing`, so served briefings are always platform-unknown, unlike a CLI request with `--platform`. Defaults are `limit` 10 and order `impact`. **(c)**: parity risk.
- MCP `views.ts:112, 315, 360, 387`: display bounds, comment chronology and fixed catch-up section order. **(b)**
- Dashboard `dashboard.ts:195`: a warnings cap with a pointer. **(b)**

## 7. Configuration and defaults

- Default role `implementer` (`service.ts:75`) and native-path role validation (`service.ts:293-298`): **(b)**
- Default order `impact` is declared in three places: `ranking.ts:15` (also `cli.ts:1054`, `rules/declared-context.ts:24`), `service.ts:338` and `api.ts:948`. **(c)**: there is no single owner.
- Project rules off for `--issue`; missing settings become "unavailable" with a warning: **(b)**

## Proposed migration order

1. **`--section` (3.1).** Build sections from native decisions, with membership and order per section, or reject non-`other-context` sections on native paths. Test: a fixture where native and `rankPickup` disagree (platform mismatch or a retained claim), and `focus.items` must follow `rankedActions`.
2. **`estimation.offered` (3.2)** from the native queue. Test: a designer fixture with TypeScript tier work but an empty native queue.
3. **Polling eligibility (1.1)** from the native evaluation, or at least with platform and retained facts. Test: `observe()` with a platform-restricted ready ticket.
4. **TypeScript findings and sections (3.3).** Stop emitting pickup-rank reasons and JSON `sections.available` on native paths, or mark them as context. Test: parity of `subjects[].findings` with `rankedActions`.
5. **Project-priority hydration order (2.1)** as a native per-item key. Test: `hydrationSubjects` with two project priorities.
6. **Transport and default parity (6, 7).** `platform` on the HTTP API and one default-order constant. Test: `api.test.ts` request parity with the CLI.
7. **Cleanup (4, 3.4).** Relabel intake as `used: "intake"`, tighten the rebrief schema, and drop TypeScript ordering in intake.

## Not audited

Read in part or not at all:

- the `src/github/shortlist.ts` selection passes, in depth;
- the `src/cli.ts` briefing flow (beyond the default order);
- the `src/mcp/server.ts` briefing tool;
- `src/serve/activity-page.ts`;
- most of `src/serve/dashboard.ts`;
- `dependencyimpact.ts` and `estimation.ts` (3.5).

A follow-up audit should cover these before migration 4 is closed.

## Follow-up

The confirmed `--section` divergence is filed as #1088.
