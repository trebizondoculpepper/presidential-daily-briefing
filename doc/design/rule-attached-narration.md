# Rule-attached narration for the Human Rules page

Implementation contract for #578. The owner wants concise English purposes
attached to native rules, with formal generated conditions expandable beneath,
while `pdb rules` remains the formal interface. This is source metadata and
presentation, not a second workflow policy or a runtime model translation.

## Source and artifact

Extend a native decision map in `policy/decisions.edn` with optional `:purpose`,
a bounded nonempty plain-text English string. For example, a purpose might read
"Prefer known easy wins: high impact with low implementation complexity."
Keep `:when`, stable ID, order/band/preference, `:why`, queries and witnesses
unchanged by adding a purpose. The existing `:why` is the matched reason, not a
replacement prose rulebook. Denial purposes may be held in a string-ID keyed
`:denial-purposes` map in the same source, validated against declared denial IDs.

Extend `build.ts`'s allowed-key validation and generated typed `DecisionRule` with
optional `purpose`; carry denial purposes as optional documentation metadata.
Reject invalid type, unknown target ID, duplicate declaration and unknown keys.
Do not hand-edit `policy.generated.json`. Missing metadata in older artifacts is
supported; it is not evidence the rule has no effect. Keep existing policy/schema
versions and decision shapes for this additive documentation field; never remove
or reinterpret a required field. If a separate project-rule format needs a
version change, follow its own explicit compatibility contract rather than accept
unknown executable syntax. The narration revision changes as documentation provenance; that is not a claim
that ranking or admission changed. Preserve existing project base-hash pins when
only these new purposes change, as specified below.

Author purposes for built-in rules displayed by this page in the first delivery.
Project/override rules may supply their own purpose through the same validated
source path. A missing purpose shows "Purpose not supplied" and the generated
formal description, not invented English or a purpose borrowed from a different
rule ID/revision. Show coverage if some rules have no authored purpose.

## English and web projection

The shared rules document carries the optional purpose alongside each stable ID,
generated conditions and effective-policy provenance. The default formal CLI text
keeps its existing generated conditions/order; adding metadata must not replace
its formal explanation with marketing prose. JSON additions are additive so older
clients can ignore them. Keep `pdb rules` useful without the web page.

The Rules page renders purpose first, then a labelled expandable Formal conditions
section. Show selected project's effective settings, policy source/revision and
any override/unknown warnings through the existing rule service, not inferred by
the renderer. Escape purpose and source text; do not interpret HTML, scripts,
Markdown directives, URLs or arbitrary template expressions.

Generic page purposes are static explanations, not evidence that a rule matched
a particular ticket. If a future detail view fills facts into narration, use only
registered witness names returned by that exact native decision/revision; missing
witnesses stay explicit. Do not query GitHub or recompute rule matching merely to
produce readable prose. No runtime LLM call or separately maintained English
priority list is part of this feature. #579's comprehension experiment is separate.

## Small implementation and acceptance

1. Add validated source/artifact/document metadata and built-in purposes without
   changing rules, then regenerate the artifact.
2. Consume it in the existing Rules page, with accessible expand/collapse controls
   and known/missing/effective-project states.

Verify native decisions before/after narration are identical on existing rules
scenarios, with no duplicate full-suite research preparation test. Focused tests
cover malformed/unknown metadata, missing purposes in older artifacts, denial-ID
binding, override revisions, HTML escaping and unchanged formal CLI conditions.
Check one narrow/wide Rules page and keyboard expansion; do not duplicate every
rule-policy scenario through each transport or claim VoiceOver without testing.
No new collector, ranking engine, configuration write or paid experiment is needed.

## Compatibility clarification: independent narration revision

A purpose is literal single-line text, at most 320 Unicode code points, excluding
ASCII control characters. Markup, URLs and template-like text remain literal; no
witness interpolation is part of a generic purpose.

Keep the existing `rulesHash` algorithm for every pre-existing bundle field,
including explanations, witnesses and lexicon. Exclude only the newly introduced
decision `purpose` and top-level `denialPurposes` fields. Thus this feature's
annotations alone do not invalidate an existing project's `:base-rules-hash`, alter
a briefing's engine identity or require regenerating decision goldens. This is a
compatibility guarantee, not a broader redefinition of which existing fields count
as semantic policy.

Add a nullable `narrationHash` for presentation provenance. When any purpose is
supplied, hash the canonical JSON array
`[1, rulesHash, decisionPurposes, denialPurposes]`, where the last two arrays contain
`[declaredRuleId, purposeOrNull]` pairs in declared source order. Include missing
purposes as null, so gaps and future IDs remain bound to that exact policy. With
no authored purposes, the hash is null; older matching artifacts may omit the
field. A matching English model and native bundle must agree on both identities,
normalizing an absent narration hash to null. Reject mixed/stale narration rather
than borrowing text by rule ID from another revision.

Carry the narration identity additively in the shared document/JSON and show it
on the web page. Keep formal CLI text unchanged for purpose-only edits. Existing
policy, English-model and rules-document versions stay unchanged for these optional
fields; validated missing metadata still renders an explicit gap with conditions.

## Project source format compatibility

The existing project source v1 has a closed preference-key set. Preserve that
format exactly: a v1 preference containing `:purpose` remains invalid. Introduce
explicit `:format-version 2` for project-purpose annotations; retain projection
version 1, the same required top-level fields and the same required preference
fields. Only v2 permits optional `:purpose`, with the same literal validation above.
All other unknown/duplicate keys and unknown future format versions remain errors.
Both formats retain every execution, grounding, authority and resource restriction.

Keep `pdb rules init` generating v1. Adding project narration requires an explicit,
reviewed file edit to version 2; never migrate, rewrite configuration or install
anything as a side effect. A v2 file without purposes is also valid. Older clients
reject version 2 rather than silently interpreting new fields as executable syntax.

Preserve v1 project/effective hash calculations byte-for-byte. For v2, the composite
identity is SHA-256 over `[2, defaultRulesHash, 1, canonicalProjectForm]`; the project
source hash continues to cover its entire canonical form, including purpose text.
These source identities can change for project documentation while identical
queries still produce identical priorities and reasons. Expose the actual format
version and exact source revision with the annotation. Verify v1 pins remain valid
after bundled-purpose changes, v1 rejects the new key, v2 round-trips metadata and
keeps execution identical, future versions refuse, and stale narration is detected.
