# Message visibility versus workflow authority: demonstration

Demonstration for #205, under the contract in [workflow message trust](workflow-message-trust.md) section 6 (#155) and the owner decision in [triage efficiency and trust](../design/triage-efficiency-and-trust.md) ("Message visibility is distinct from authority"). It is a bounded example with injected fixtures. Real mutations are disabled. No production code changes, no live label or claim changes, no paid trials.

**Outcome:** the boundary classifies every fixture in the #155 matrix as the contract expects, by reusing the production #212 rule rather than restating it. External reports stay listed and source-linked; their text never becomes a workflow record, an instruction or a write. This proves classification behaviour only. It does not show that any LLM resists prompt injection in text it is shown.

## What was built

- [`examples/visibility-authority/decide.ts`](examples/visibility-authority/decide.ts): `decide(message, permissionLookup, authorizations) → {visibility, authority, reasons, …}`, plus `listExternal` (external reports with source links and marker-stripped excerpts) and `planMutation` (the state/ownership gate; `executed` is always `false`).
- [`examples/visibility-authority/decide.test.ts`](examples/visibility-authority/decide.test.ts): 33 fixture tests, run by `npm test` (the Vitest include already covers `doc/reports/examples/**/*.test.ts`).

Reused, not duplicated:

| Production code                                                                           | Used for                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `markerTrust` / `commentAuthority` (`src/workflow/delivery.ts`, `src/workflow/claims.ts`) | Author and editor authority, apps/bots refused, unknown never trusted (#212)           |
| `permissionLookup`, `writePermissions` (`src/github/github.ts`)                           | REST fixtures for 403/404/429/transport errors and `role_name` custom roles            |
| `parseQuestionMarker`, `questionRecordBody`, `parseQuestionRecordBody`                    | v2 repository/issue binding (replay) and the reported agent name                       |
| `readHumanEvidence` (`src/briefing/human.ts`)                                             | Shows a forged needs-human record from an outsider is counted untrusted, never current |
| `codexMarker`, `codexReviewer` (`src/workflow/reviewevidence.ts`)                         | Review-state evidence from the allowlisted app only                                    |

Two values are new to the demonstration and are not production behaviour: the `authorize-message v1` / `revoke-message v1` record format proposed in #155 section 5, and the `visibility` labels.

## Evidence: the fixture matrix

| #155 fixture                                              | Result in the demonstration                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Write author, unedited record                             | `verified-write`, `workflow`                                                                         |
| Maintain or admin via `role_name`                         | `workflow` (through the real `permissionLookup`, legacy field `read`)                                |
| Triage or read collaborator                               | `visible-untrusted`, `none`                                                                          |
| Association `OWNER` with read permission                  | `none`: association is a display hint, never proof                                                   |
| External author with injected commands and forged markers | `external-untriaged`, `none`, listed with its link; forged claim/Codex markers stripped from excerpt |
| Forged needs-human record from an outsider                | `readHumanEvidence` counts it untrusted; the genuine older record stays current                      |
| 403, 404, 429, no status, transport error                 | `unknown`, `none`; never labelled external                                                           |
| Write author, edited by a read-only editor                | `none`                                                                                               |
| Write then, read now (and the reverse)                    | Decided on current permission only, on every read                                                    |
| Allowlisted Bot with a Codex marker                       | `app`, `review-state` only                                                                           |
| User account posting a Codex marker                       | `none`; reason says it may add a blocker, never clear one                                            |
| Non-allowlisted app                                       | `external-untriaged`, `none`                                                                         |
| Write author authorises comment X at revision R           | X is `consider-only`; another comment by the same author stays `none`                                |
| Authorisation, then X edited                              | Void                                                                                                 |
| Self-authorisation inside X                               | Ignored                                                                                              |
| Authorisation by a read-only or unknown-permission author | Ignored                                                                                              |
| Later trusted revocation                                  | Void                                                                                                 |
| Two agent names on one write account                      | Both `workflow`; `githubActor` is the account, each agent `certainty: "reported"`                    |
| Record bound to another issue (replay)                    | `none`, reason `replay`                                                                              |
| `consider-only` or `none` reaching the mutation gate      | Refused                                                                                              |
| `workflow` on a closed, stale or other-owned ticket       | Refused; allowed only when open, fresh and unowned or owned by the acting agent                      |

The replay fixture uses the needs-human v2 binding, which is the binding that exists in production today. The #155 matrix names a release record; release records have no repository binding in their payload yet (see follow-up 3).

## Design notes

- `consider-only` is deliberately weaker than `workflow`. An authorised message may be read as input by a trusted agent, but it never supplies a trusted record and never passes `planMutation`. Its author gains nothing for any other message.
- A field that was not collected is unknown, never a positive fact. An allowlisted app's review marker whose edit fields (or editor, when edited) were not read is unverified and cannot clear a blocker; a review marker edited by another account is ignored; a `[bot]` login without an account type is unknown; an authorisation is void when the target's edit fields were not read, since its revision cannot be established.
- Unknown permission is kept apart from external. A token that cannot ask is missing evidence, not a verdict about the author.
- `untrustedData` is `true` for everything except a verified-write message. A consumer that shows message text to an agent should quote it as data when this flag is set.

## Limitations

- **Classification, not model behaviour.** A passing suite shows the tool will not treat external text as authority. It cannot show that an LLM reading the displayed excerpt ignores instructions in it. That remains unknown, and no paid trials were run.
- **Present permission only.** GitHub exposes no historical permission. A record is re-judged on every read.
- **Shared account.** Verified write proves "someone holding a write-capable account", never which agent. Agent names stay reported.
- **Last editor only.** GitHub exposes the last editor, not every editor; the #212 rule relies on only write users being able to edit.
- **Apps.** Authority for apps is an allowlist, not a permission check; the allowlist is a configuration surface that needs its own review.
- **Fixtures, not live data.** Response shapes follow the #155 schema checks of 2026-11-13; they are not re-verified here.
- **No signing.** An authorisation record is trusted because of its author's current permission, not a signature.

## Proposed follow-up production tickets

Described here only; none were created. Each needs review before implementation.

1. **Mark external content as untrusted data in intake and briefings.** Apply the `external-untriaged` listing and `untrustedData` quoting to `--issue` intake and briefing excerpts, with source links, so agent-facing text separates evidence from instructions.
2. **Allowlisted-app review state.** Require `__typename == "Bot"` plus the allowlisted login for Codex/CodeRabbit state in `prstatus`/`reviewevidence` (#155 A5), so a user-posted marker can add but never clear a blocker.
3. **Bind release records to repository and subject.** Add the binding inside the release payload and require `claimedAt` to match the claim being reworked (#155 A1/A2), so copied records fail.
4. **Per-message authorisation records.** Implement `authorize-message` / `revoke-message` as a reviewed contract and CLI command, writing `consider-only` semantics only.
5. **Permission status in history and catch-up views.** Show `verified`/`untrusted`/`unknown` beside the existing `certainty: "reported"` (#155 A7/A8) and on estimate provenance (A4).

## Verification

`npm run fmt`, `npm run check` (including `rules:build --check` and the examples `tsc`), `npm run rules:test`, `npm test`, `npm run build` and `npm run package-test` were run before the PR.
