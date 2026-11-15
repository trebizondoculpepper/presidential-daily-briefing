# Declared either-provider review evidence

Product contract for #301, applying `review-gate.md` through registered policy rather
than a repository-specific exception. This document changes no runtime gate, branch
protection or publication behavior. Advice is not authority to merge.

## Configuration and compatibility

Register repository setting `review.policy`, with values `legacy` and
`codex-or-coderabbit`. The latter selects a declarative registered policy:

```text
id: codex-or-coderabbit
coverage: any
providers: [codex, coderabbit]
findings: all-known-substantive
```

The policy definition/provider registry is shared executable data. No repository
name, issue number, branch name or named agent selects it. Account/app identities
belong only in verified provider adapters. Do not grow an arbitrary user-supplied
expression language to implement this one policy.

Absent setting preserves existing legacy behavior and reports `undeclared`/legacy
compatibility explicitly; do not silently assume all consumers opted into this
repository's OR rule. Explicit `legacy` is distinguishable from absent configuration.
Invalid/unregistered values fail normal configuration validation. Unreadable or
ambiguous effective config is unknown, not an excuse to adopt either-provider or
quietly guess legacy. Remote reads without verified local config report that scope.

Use the existing repository config service and `pdb config` help/get/set/list.
Document the setting as planned until implemented. In the implementation PR, this
project may explicitly select the registered OR policy to match its already agreed
process; do not add an unsupported config key before that runtime registry ships.
No global identity or other project's settings are modified by a remote read.

## Normalize actual provider evidence

Provider adapters collect source facts: authenticated integration identity, full
reviewed commit SHA, observed completion/outcome, finding state, source URL and
coverage. They do not decide action priority or grant merge permission. Bind all
positive coverage to the live head, not the branch name, PR number, check name or
a short SHA. A new head invalidates previous acceptance.

Codex uses its attributable completed code-review state with unresolved findings
explicitly false, or another supported attributable approval representation. A
security-only receipt is not silently a code-review approval. CodeRabbit uses an
attributable current-head APPROVED review or an explicitly verified supported
provider result that proves a completed passing/clean review. A generic successful
check alone is insufficient. Check-run app identity/head and receipt author/type
must be verified from GitHub API facts, never a caller-supplied display name.

The current CodeRabbit negative examples inspected for this design were neutral
`Review rate limited` runs, with analysis/feedback steps skipped, published by the
`coderabbitai` app. They establish a rejection case only. No passing receipt format
was demonstrated by that sample. Before adding a parser for a non-formal positive
receipt, the implementer must document/verify its actual provider representation
and add sanitized synthetic positive/negative fixtures. Never invent a text match
that declares any success, provider mention or completed check a clean review.
Unknown provider formats remain unknown. No paid review or live review trigger is
required merely to test this code.

Keep workflow-message authority separate: provider bots may supply registered
review evidence without becoming trusted authors of arbitrary workflow instructions.
A copied Codex/CodeRabbit marker posted by another account is ignored as positive
review evidence. Unknown attribution cannot establish acceptance. Use stable
server observation/order and supported protocol supersession; conflicting receipts
are reported, not resolved by selecting whichever says clean. A receipt's payload
timestamp cannot override server provenance or a current unresolved review thread.

Normalize each configured provider to `accepted`, `findings`, `pending`, `stale`,
`skipped`, `error` or `unknown`, retaining its source and reviewed head. Neutral/
quota-skipped/error/stale results never satisfy coverage. A current known substantive
finding from either provider is a veto until actually fixed/resolved or explicitly
disposed of through the existing reviewed process; another clean provider is no waiver.

## Coverage and independent blockers

With declared OR policy, review coverage is satisfied when at least one configured
provider has verified accepted evidence on the current full head. Pending, stale,
skipped or errored optional-provider coverage is not an extra AND requirement.
Explain which provider satisfies the policy, with its source link, and keep the
other observed state as detail rather than a false blocking requirement.

Required CI, conflicts, GitHub protections, draft state, delivery responsibility,
unresolved substantive findings and fresh mutation authority remain independent.
Do not suppress a failed required check because its name resembles a review provider.
A provider's optional coverage check is not automatically a required CI check,
but actual branch protection can require it and this policy cannot bypass that.
Unknown protection/access evidence never becomes permission to force a merge.

Missing optional acceptance is distinct from incomplete finding evidence. If the
comments/reviews/threads required to establish the absence of outstanding findings
are truncated or unavailable, report the relevant unknown and withhold conclusive
merge-readiness advice. One visible clean receipt does not prove an unread history
contains no findings. Conversely, merely not having a second provider's positive
receipt is not itself evidence of such a gap. Preserve source-specific completeness.

## Shared rules, rollback and output

Extend normalized raw provider facts and registered policy inputs through the
shared read boundary. Native Datalog determines configured coverage/eligibility and
ranked reasons from those facts; do not add provider/repository special cases in
the text renderer. Keep raw I/O/provenance validation outside the pure engine.
The TypeScript rollback/evidence helper implements the same declared policy data
and fixture matrix. No role or transport invents its own interpretation.

Update `pr`, delivery follow-up, role briefings, `who`/`team`, Doctor, MCP and serve
projections that consume the existing head-accepted result. Human inferred sign-off
uses that same result. Preserve public fields and add a versioned `reviewPolicy`
detail containing declared/effective policy state, coverage, satisfying providers,
per-provider head/state/source and explicit unknowns. Existing `headReviewed` remains
the current-head accepted-coverage Boolean; incomplete qualification is retained in
coverage, not disguised as a proven rejection. Known findings retain their separate
blocking evidence.

Native predicates/inputs carry source IDs and lexicon entries so `pdb rules` and
the web policy view account for the new represented conditions. Do not replace
executable policy with separately authored English. Legacy source fixtures keep
their documented behavior; explicit OR fixtures test new behavior without a hidden
repository default. Render explanations once, with detail available on demand.

## Verification and rollout

Inject config, provider, GitHub and clock boundaries. Cases: Codex-only clean,
CodeRabbit-only clean, both, neither, optional provider pending/stale/quota/error,
unregistered/copied/spoofed source, full versus short/mismatched head, a new head,
generic green check without review, malformed/future receipt and conflicting states.
Test known findings from either provider, unresolved threads, incomplete histories,
required CI/conflicts/draft protections, absent/explicit legacy/invalid/unreadable
policy and cross-repository config isolation.

Assert native/rollback and CLI/MCP/read-service parity, correct source links and
unchanged mutation boundaries. Verify no optional-provider stale/pending banner
overrides satisfied OR coverage, and no clean provider hides another's real finding.
Package smoke covers configuration/help and fixture-backed read output. A unit or
synthetic receipt test is not native-client acceptance, a real passing vendor review
or proof that a live merge is safe. Runtime change follows this reviewed contract.
