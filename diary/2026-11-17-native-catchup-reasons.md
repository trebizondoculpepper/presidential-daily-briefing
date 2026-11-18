# Native PR decisions in catch-up reports (#710)

Catch-up reports now reuse the shared snapshot PR-readiness evaluator for current status, all applicable blocker reasons and next-step advice. TypeScript retains evidence presentation and deduplication, rather than selecting a competing status precedence or assuming a check named verify.

Live CLI briefings resolve the target checkout's declared review policy before saving the snapshot. Offline replay uses the saved policy without rereading configuration. PR detail links use PDB inspection.

Regression coverage includes real required checks without verify, unfinished advisory checks, missing/stale requirements, simultaneous blockers, and live/offline review-policy context. Existing native readiness and workflow-policy-boundary contracts apply; no new policy is introduced.
