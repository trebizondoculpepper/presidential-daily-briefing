# Explicit briefing focus and section expansion

Contracts for #311 and #312. Reuse next-steps-only.md, lean-briefing-rows.md,
blended-action-queues.md and the registered role/section selectors. These are two
independent implementation slices. Neither changes the default top-ten policy,
permissions, claim guards or completion rules. This is not shipped help yet.

## #311: request a complete section

Add `--section ID` for a registered section of the selected role. Use stable
selector IDs from the role registry, not English headings or a second hand-written
list. Help lists valid IDs for each role. An unsupported/unknown/empty ID returns
an argument error listing the selected role's supported choices. One section per
request; do not add an arbitrary query language. Default role selection is unchanged.

This is an explicit detail request: render only a minimal repository/role/section
header, material evidence/freshness warnings, and that section's ordered rows. Lift
its fixed _row_ cap. `--limit` remains the next-actions limit and does not silently
become a section limit. The independent text/transport byte budget still applies;
lifting a row cap never means unbounded bytes or a promise of full collection.
Keep the existing truncation notice and whole useful rows where practical.

Compute the section through its existing shared selector and ordering over the same
normalized facts. Do not transform background/waiting/inspection rows into eligible
pickup because their section was explicitly selected. Preserve action kind, supported
commands, evidence links and reasons. A section with no rows is empty only within
that scope and the observed coverage. Incomplete collection cannot say no work exists.

Structured output identifies the requested section, total observed rows and shown/
omitted counts. Preserve existing report fields; section focus is a presentation
selection, not deletion of stored facts or a new schema interpretation. CLI and MCP
text use the same projection; add the equivalent optional MCP `section` input to
briefing tools with identical validation. HTTP services reuse that input rather than
another ranker. Do not require background `context` just to ask for a named section.
Reject contradictory `--section` with `--full` or a different focused command such
as `--issue`; explain the supported separate requests rather than guessing precedence.

Omission hints must distinguish causes. For a fixed section row cap, name the exact
supported `pdb --role ROLE --section ID ...` request. For a byte cap, say truncated
due to maximum size and offer a focused detail/budget request when it fits. Do not
claim `--max-chars` raises fixed row caps or that `--json` is exhaustive when source
coverage is incomplete. This hint changes only when the actual option ships.

## #312: filter candidates by label

Add repeatable `--label NAME`, with **AND** semantics: a candidate must have every
requested label. Duplicate resolved labels are idempotent. Limit to eight distinct
labels and validate nonempty bounded names. No regex, title search or negative/OR
syntax in the initial slice. Header and structured output record resolved canonical
labels and AND semantics. Every result is visibly a filtered view, never a whole-board
all-clear. The default with no labels is unchanged.

Resolve requested labels against the selected repository through the existing gh
boundary. Use canonical repository label identity/name rather than ad hoc substring
matching or title inference. A confirmed nonexistent label returns a clear unknown-
label argument result naming it; do not silently produce an empty queue. Permission,
quota, timeout or incomplete metadata is an explicit unresolved-filter error, not
proof the label is absent. No label is created or renamed. Bound lookup work to the
eight requested labels, sharing one bounded query when supported. Discovery still
collects the authoritative facts required by normal eligibility; do not turn label
filtering into a partial GitHub inventory presented as full.

Keep the complete collected graph, claims, review/authority evidence and role facts
for evaluation. Apply the label predicate to the candidate pool before ranking,
section budgets and final action selection. Do not remove nonmatching blockers or
owned work from the underlying facts: doing so could make a blocked ticket look
eligible or permit an extra claim. Evaluation of an included candidate uses the same
rule reasons, urgency, dependency counts and default tie-breaks as an unfiltered run.
Global obligations never become satisfied merely because this view excludes them.

Match a ticket action on its ticket's labels and a PR action on that PR's labels.
Do not implicitly inherit labels through closing references, body text or dependencies.
For a supported aggregate action spanning several tickets, include the matching
members only and identify that the aggregate is scoped; preserve an explicit count
of owned obligations outside the filter rather than presenting this as a complete
ownership review. If the current model cannot represent that scope safely, return
a scoped inspection summary for the aggregate instead of a misleading actionable
command. Incomplete label coverage leaves membership unknown and marks the filtered
result incomplete; it is not a known nonmatch.

Use the same filter across NEXT STEPS, explicit role sections, available work,
attention/dependency views, counts and machine-readable subject projections. Detail
may retain linked nonmatching dependency evidence with an explicit 'context outside
filter' distinction. Do not render unrelated candidates as though they match. State
once that the view is scoped and, when known, how many owned/attention obligations
are outside it. This warning is informational; it does not overrule the user's filter
or cause excluded tickets to reappear throughout the list. Shared incomplete/stale
warnings remain visible and are not filtered out by ticket labels.

Filtering is presentation/candidate scope, not a cache-authority key. Reuse shared
read facts safely, but include normalized label IDs/names and semantics in any cached
rendered result key. No cross-project, role, identity, platform or source-generation
view is reused accidentally. MCP inputs mirror CLI as an optional label array; the
same service drives CLI, MCP and future web filtering. Existing mutation commands
continue to use fresh unfiltered authority facts.

## Shared acceptance and delivery

Keep each ticket's own implementation PR and estimate. #311 can ship without #312;
#312 cannot advertise section expansion until #311 ships. Combining them after both
ship composes filtering then section selection, preserving independent byte limits.
No current owner decision or paid trial is required.

Tests use injected GitHub/clock facts and native rules fixtures:

- #311: both roles, each supported selector, over-cap and empty sections, invalid ID,
  matching omission hints, byte truncation, incomplete evidence, default unchanged,
  CLI/MCP parity and packaged help/command behavior.
- #312: one/repeated/duplicate labels, AND behavior, canonical resolution, unknown
  versus unreadable labels, lookup bound, no substring/title/implicit PR inheritance,
  incomplete label coverage, scoped aggregate and obligations-outside warning.
- Preserve complete native blockers, ownership/claim restrictions and review/authority
  facts when a relevant prerequisite has a nonmatching label. Test both engines,
  action kinds, ranking/ties, dependency context, sections/counts and structured scope.
- View/cache key isolation and composition of the two features; no extra network
  calls from merely expanding already-collected rows, and measured bounded metadata
  work for label resolution. No new credentials or GitHub writes.

Existing estimates remain S/M for #311 and M/M for #312 (complexity/impact). Merging
this contract makes their runtime slices ready; it does not implement either flag.
