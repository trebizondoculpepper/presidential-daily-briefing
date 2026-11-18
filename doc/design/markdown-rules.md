# Markdown presentation for generated rules

Owner-approved presentation contract for #1049, 18 November 2026. Render the existing
shared versioned rules document as ordinary readable Markdown by default. Native
policy decisions and structured `pdb rules --json` remain unchanged.

## One renderer and complete content

Extend the pure shared English/document renderer rather than adding a second policy
source or an LLM rewrite. Use standard heading levels for policy identity, defaults,
decision groups, rules, predicates, ordering/overrides, evidence/glossary and boundary
notices. Give stable rule IDs visible headings; use explicit nested lists for all/any,
negation and scoped conditions so logic does not depend on visual indentation alone.
Use inline code for IDs, predicates, variables, flags and settings and fenced blocks
for literal syntax when appropriate. No terminal ANSI styling or HTML-only structure.

Preserve each rule ID, condition, quantifier, negation, exception, evidence witness,
ordering relation, declared override, glossary and formal/narration identity.
Authored purpose remains distinct from formal conditions under
[rule-attached narration](rule-attached-narration.md). A purpose-only edit still does
not alter decisions; this formatting change may change text layout without changing
its policy meaning. Unknown/missing purpose and coverage remain explicit.

Escape Markdown from literal values and project-defined source text without
changing the literal represented: handle backticks, fences, brackets, backslashes,
newlines and terminal controls. Render arbitrary text as inert data, never links,
HTML or injected headings that can masquerade as policy. No live private snapshots
or unsafe link destinations. Prefer generated structural Markdown over giant code
blocks that merely reproduce the old indentation format.

## Full, filtered and reused output

`pdb rules`, `--rule ID` and `--role ROLE` use the same renderer. Filters visibly say
which subset is shown, retain needed predicate/precedence context and omissions,
and never claim to be the complete policy. Existing command meaning, exit codes,
matching/invalid-artifact errors and JSON schema stay intact. No new --format option
or alternative legacy renderer is required for this owner-approved default change.

[Onboarding](onboarding-rules-files.md) generates rules.md through this same renderer,
with its managed snapshot metadata. Add a native dependency from that implementation
to #1049 so it does not ship a second Markdown formatter. Action-rule reminder
projections reuse the same English content/formatting primitives but retain their
own concise outcome-specific structured schema. They do not dump the full document.
The API-first Rules page may project the shared document as appropriate; this
presentation ticket is not a separate frontend migration.

## Acceptance

Focused fixtures exercise full and filtered documents, nested all/any/negation,
ordering/overrides, missing purpose, source escaping and exact policy/narration
provenance. Compare document/decision semantics before/after; do not regenerate
native decision goldens solely for Markdown. Preserve JSON shape and filtered scope
notices. Test generated onboarding content through the shared renderer once that
feature lands. Update delivered help/docs to say the default is Markdown. Normal
checks/tests/build apply to the eventual executable change. No broad architecture
rewrite, new dependency or research experiment is needed.
