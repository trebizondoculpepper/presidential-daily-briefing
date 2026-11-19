# Native action obligations and early publication

Owner decision, 19 November 2026. This addendum supersedes the allowance in
[action reminders](action-rule-reminders.md) for a separate TypeScript-authored
procedural-obligation catalog. It refines the
[native workflow-policy boundary](workflow-policy-boundary.md), not admission,
ownership, technical safeguards or the merge/release gate.

## Current implementation versus required boundary

Claim output currently combines native decision explanations with five procedural
obligations authored in `src/rules/datalog/action-reminders.ts`. Those paragraphs
and their applicability are a second policy source even though they live inside
the rules component. Their presence is migration debt, not proof that all pickup
guidance is generated from native rules. This documentation does not remove them.

Native policy must define both the obligations and their applicability to the
action, actual outcome, role and available facts. The shared engine returns the
applicable obligation IDs, native evidence/witnesses, coverage and effective policy
identity. The shared English generator narrates those native rules through the
existing structured document boundary. TypeScript gathers typed facts and formats
that result; controllers and renderers do not own an obligation list, role matrix
or independent ordering/fallback policy.

Generic grammar, the predicate glossary, escaping and output framing remain
presentation. Policy purposes follow the existing rule-attached narration
contract. Merely moving the five English paragraphs from TypeScript to an EDN or
JSON string table does not establish native obligation semantics. A policy edit
must alter selection and the corresponding generated explanation without editing
a command's policy paragraphs. Include executable applicability and ordering in
effective policy provenance; never label a decision change as narration-only.

Admission reasons and ongoing duties remain distinct. A duty can instruct the
agent to preserve or publish work; it is not evidence that the tool performed
that action or that the agent complied. Do not invent filesystem, push, review,
human-direction or delivery facts just to produce a reassuring reminder.

## Claim migration

Move the five existing duties together: acceptance criteria/applicable architecture;
respect for human ownership and active claims; explicit blockers and questions;
preservation and truthful handoff on removal; and implementer responsibility
through review, CI, fixes and merging. Preserve role-specific applicability and
stable IDs where possible. Version any incompatible result change explicitly.

Native scenarios must distinguish confirmed success, already-owned no-op, refusal,
partial/uncertain writes and unresolved role/context. A denial cannot confer
new-owner obligations. Recovery guidance must reflect the actual action outcome.
Policy/query failures remain explicit, never a hidden TypeScript policy fallback.

The existing six-item/2,000-code-point terminal bound and structured complete
selection, omission and coverage fields remain. Native display ordering must make
the new early-publication instruction visible on applicable pickup results;
policy may prioritize it over other displayed content, with truthful omissions
and lookup references. Do not add a command-local priority exception. Policy tests
and the claim projection fixture must demonstrate that this obligation actually
appears within the bounds, not only in an omitted catalog.

Keep mutation receipts and valid JSON stdout intact. Rendering failure after a
successful write is a presentation warning, not grounds to retry the mutation.
Release/unclaim and PR submission retain their own policy/integration tickets and
reuse this mechanism; this claim slice does not implement those actions.

## Minimize unpublished work

The owner-approved duty for an agent changing repository files is:

> Minimize unpublished work. Once a coherent change passes the applicable local
> checks, commit and push it promptly. Open a draft PR as soon as there is useful
> work to inspect, and keep it updated as work progresses. Do not wait for the
> whole ticket to be finished.

A draft explains what works, what remains and known failures or unverified
acceptance. It can be incomplete; that does not waive the applicable local checks
for the changes being committed. CI or remaining ticket-level acceptance may
still be pending. Follow existing checks, private-file safeguards and ordinary
authorization for committing/pushing; do not publish credentials, another agent's
work or unrelated files. No force-push or review/merge bypass is authorized.

The purpose is recoverability if an agent stops, visible progress, designer
scrutiny and incremental code review. The duty applies to documentation as well
as implementation changes. Observational work with no repository changes does
not imply that a commit or PR must be manufactured. There is no arbitrary timer,
commit-count target or instruction to push every keystroke.

Express applicability and explanation in native policy and include the duty in
the pickup reminder through the shared generator. This is an instruction to the
agent, not automatic commit/push/PR machinery, a new credential flow, or an
admission prohibition based on guessed unpushed state. A push/draft is not merge
readiness and does not complete the ticket or release continuing responsibility.

## Delivery and verification

1. Reviewed contract: this addendum and the central architecture link.
2. Native policy: migrate the five claim obligations and reusable action query;
   minimal fact adapters, native scenarios and English/provenance checks.
3. Separate native policy: add the early-publication duty and bounded-display
   selection scenarios through that mechanism.
4. Engineering: consume the native result in claim output and delete the old
   TypeScript catalog, handwritten applicability and fallback selection.

The integration depends on both policy slices. Existing release/submission
policy tickets adopt the native query before their own display integration.
Validate that native rule edits flow into generated text, that denied/partial
actions never appear successful, and that source identity, coverage, sanitization
and omissions survive projection. A merged contract alone does not finish the
runtime migrations or prove that any agent has pushed work.
