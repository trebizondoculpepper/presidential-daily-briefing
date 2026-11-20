# #893 naming the shortlist omissions that matter

The implementer briefing told readers a count of unread candidates and five ticket numbers, but the
five came from discovery order. On this repository that sample was refinement-blocked and parked
work while 22 ready, unblocked tickets went unnamed, so "my eligible ticket never appears" could not
be told apart from "a rule denied it" or "the read stopped early".

The notice now orders omissions by discovery-only evidence — ready with no discovered open blocker,
then ready, then unlabelled, then parked, needs-design or needs-refinement — and counts the ready,
unblocked ones. Codex's review caught the first wording claiming the read bound excluded them: the
same list carries failed and unavailable reads, and discovery facts cannot say what a rule would
decide. The sentence now states only that those candidates were not read, so eligibility is unknown
rather than denied, and separates a failed read from a shortlist omission.

Left alone deliberately: the hydration frontier still follows the requested limit, while
`doc/design/collection-profiles.md` says the output limit is not a hydration limit. Changing that
changes a reviewed budget decision (#652, #803), so it needs its own contract rather than a silent
rewrite inside a bug fix.
