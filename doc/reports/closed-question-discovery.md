# Bounded discovery of questions on closed sources (#491)

Research on 15 November 2026 against main `12b5c87`, by farhad_taphrale in Codex.
This is API/source investigation plus synthetic counterexamples, not a live
question migration or proof that any sampled historical question is unanswered.
It proposes the implementation contract for #414; #412 owns question transitions.

## Evidence and request budget

Six read-only REST requests were made using existing authenticated `gh` (no new
credentials). Raw responses remain outside Git; only aggregate/public observations
are recorded here. The maximum authorized research budget was twenty requests.

1. Search issues in this repository with `is:issue is:closed`, the literal
   `"github-triage:needs-human"` and `in:comments`, `per_page=10`. It reported 14
   matches, `incomplete_results=false`, and returned ten candidates. This is search
   coverage, not proof of all workflow obligations or of the records' authenticity.
2. List closed issues with `sort=updated&direction=desc&per_page=100`. The response
   contained 100 records, only 37 of which were issues: the REST issues route also
   returned PRs. Its Link header advertised another page, using an `after` cursor.
3. Fetch numeric page 2 of that list: 100 records, no ID overlap with page 1 in this
   observation. Do not infer snapshot isolation or guaranteed numeric-page stability
   from this small read; implementation should follow actual Link continuations.
   4–5. Read all first-page comments on two search candidates, #411 and #245. Each
   returned seven comments and no next-page link. Both contained a genuine-shaped
   needs-human marker while their current labels lacked question/decision labels.
   Under existing legacy compatibility these labels may mean resolved; their
   presence is a discovery counterexample, not a reason to resurrect them.
4. List closed issues filtered by `labels=question`, `per_page=100`: six results.
   Search included additional unlabelled candidates such as #411/#245. Therefore a
   label-only query cannot discover all records, even with fully paginated labels.

No issue, comment or label was changed to manufacture these observations. Normal
research claim/estimate tracking is separate from the read-only experiment.

Source inspection: `src/briefing/human.ts:readHumanEvidence` skips non-OPEN issues,
selects the newest trusted marker and counts earlier ones as superseded. Its legacy
resolution projection uses complete removal of question/decision labels. This is
correct for its current contract but insufficient for independently bound question
operations, which #412 says resolve/withdraw explicitly by comment ID and op ID.

## Capability comparison

| Candidate source                                       | Useful for                                    | Cannot prove                                                               |
| ------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| Closed issues with question/decision labels            | Cheap likely legacy obligations               | Unlabelled records, explicit bound operations, authenticity                |
| Comment-text issue search                              | Additional candidate hints                    | Search indexing completeness, absence, exact marker validity or resolution |
| All-state issue inventory plus full comment pagination | Discovering records independent of labels/age | An atomic GitHub-wide snapshot; bounded prefixes are not exhaustive        |
| Known explicit question IDs in a running server        | Immediate stable obligation refresh           | Cold-start discovery after memory loss                                     |
| Changed inventory since a finished baseline            | Efficient incremental refresh                 | Older unseen records if the baseline never finished                        |

Recommendation: one bounded all-state inventory scan with comment hydration and
continuations as the correctness path. Labels/search can prioritize candidates,
but are never the only discovery source or grounds for an all-clear. No database
or durable index is required. Restart loses scan progress and must honestly restart
an incomplete baseline; it cannot claim the previous process's coverage.

## Contract proposal for #414

Use the existing shared human/question reader and authority checks. Extend it with
a closed-source discovery collector, not a second decision engine. First service
request starts work; no startup prefetch or background polling. Keep aggregate scan
state and discovered obligations in memory with the normal short TTL. Do not cache
independent pages as if they were a coherent ticket snapshot.

Default one request consumes at most thirteen GitHub requests overall, with at
most three inventory pages and ten comment pages, each at most 100 rows. Permission
lookups and rereads consume this same budget, reducing available hydration pages;
never hide unbounded trust calls outside the limit. Expose these bounds in
coverage. Follow Link/cursor continuations, discard PRs, deduplicate stable issue
IDs, and queue comment hydration rather than fetching every comment eagerly.
A high-comment source cannot monopolize the budget: retain a per-source cursor
and rotate pending sources. Never treat an unhydrated issue as having no questions.
Return a bounded opaque continuation, tied to server instance, repository, filter,
scan start and generation. It can reference server-side memory, not embed ticket
contents or credentials. Expired/lost/mismatched continuations restart explicitly
with incomplete coverage, never silently skip to an assumed checkpoint.

Track inventory pages/rows, discovered issues, hydrated sources, pending sources,
comment-page gaps, permission gaps, start/fetched times and continuation separately.
Coverage is incomplete until the inventory and every relevant comment chain finish
and authority/resolution evaluation succeeds. A truncated scan can show positively
verified questions already found, but must say closed-source discovery is incomplete,
not “nothing needs attention”. Ordinary display limits are independent of source
coverage and expose their own omissions.

This is an observed pass over a mutable API, not snapshot isolation. Follow actual
continuations; reread changed sources before asserting their resolution. After a
finished baseline, a request may use an overlapping `since` updated-history pass,
deduplicating IDs and refolding changed comments. Publish the time interval and
watermark; never advance it past failed/unread pages. Overlap plus rereads mitigates
concurrent changes, not an exactly-once/atomic guarantee. If change churn or a page
gap prevents a trustworthy complete pass within bounds, remain incomplete and
continue. Manual refresh restarts/revalidates; mutations still require fresh checks.

### Question identity and compatibility

Retain all independently bound question operations, not only the newest record on
a ticket. A resolution/withdrawal must bind the exact repository, issue, source
comment and question op ID; an operation for Q2 cannot answer Q1. Replays and copied
markers must not resolve another source. Current author/editor write authority
still applies; unknown permissions or malformed potentially authoritative history
mean unknown, not resolved. Arbitrary replies, closure, merge and label removal do
not resolve explicitly bound questions. Source links continue to point to the
closed ticket/comment; never reopen, clone or assign it to keep the question alive.

An additional format detail must be explicit before #412/#414 ship: merely lacking
a resolution marker cannot identify a legacy question, because a new unanswered
question also lacks one. Recommend that new `needs-human` writes carry a versioned
v2 question marker binding repository/issue/opId and declaring explicit-resolution
semantics, while keeping the readable question body. This replaces the marker in
the same comment, not an extra comment or a remote index. Parse legacy v1 separately:
complete label removal retains its existing compatibility meaning. New v2 questions
require explicit resolve/withdraw whether the agent retained or released its claim.
A bound wait/resolution that refers to a legacy ID identifies that specific adopted
obligation; adoption is explicit, never inferred from age or a label.

This is a proposed amendment to #412's question-record detail, not a live migration.
It prevents resurrecting all old unlabelled records while ensuring new --release
questions survive closure. Unknown/unsupported versions remain visible diagnostics.
Document a later adoption command separately if needed; do not rewrite history.

## Reproducible counterexamples and implementation sequence

Run `node doc/reports/examples/closed-question-discovery.ts`. The synthetic examples
prove why label-only, newest-only and bounded-prefix absence are unsound, and why
resolution must use exact operation identity. These are design examples, not tests
of a shipped #414 collector, trust parser or actual GitHub snapshot isolation.

1. Review this discovery/coverage contract and v2 question discriminator with the
   #412 transition contract. Implement that discriminator through the shared writer/
   reader, preserving legacy fixtures, then bind resolution and wait operations.
2. Implement bounded all-state closed-source candidate/comment collection and opaque
   memory-only continuations with injected transport/clock. Add #414's native edge
   on the required #412 question interface; do not mark ready on this report alone
   if the interface is still ambiguous.
3. Extend shared question facts and native human rules, then reuse them in CLI/MCP/
   REST/dashboard. Closed source does not become implementation pickup or completion.
4. Required fixtures: old unlabelled source outside first pages; restart/expired
   cursor; PR filtering; shifted pages/deduplication; multiple question ops;
   --release v2 question; legacy label removal; exact resolve/withdraw; copied/edited/
   untrusted/unknown-author records; comments >100; arbitrary reply/merge/closure;
   inaccessible source; small request budgets; bounded output with explicit omissions.

The main unresolved technical limit is mutable-page consistency, handled by visible
coverage/freshness rather than an invented guarantee. No new owner preference,
persistent backend, paid trial or live migration is needed for this bounded design.
