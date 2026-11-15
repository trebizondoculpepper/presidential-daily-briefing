# Shared rebrief core (#506)

Claimed as priya_xu at the owner's request in the fresh feat/506-shared-rebrief-core worktree. Implemented the merged #507 contract: explicit opt-in and context, live shared-service role/platform read, validated actionable changed shortlist, semantic fingerprint, bounded deadline/cancellation, acknowledged delivery and per-session cap. Added a process-per-hook CLI with private temporary hash-only state and exclusive atomic updates. No native hook, model run or repository configuration is installed.

HTTP MCP currently cannot request force-refresh or explicit platform, so that transport reports its capability gap and stops without a request; it does not fake fresh-read parity. Native Codex continuation/receipt remains #398. CLI and core tests use injected facts, time, transport and state, with real temporary-file concurrency/privacy checks. Added doc/rebrief.md for exact setup, acknowledgement, removal and unsupported boundaries. No TODO.md exists in this checkout.

Caught and corrected an initial workspace routing mistake before commit: moved only the new files/service edit from the original checkout to this worktree, restoring the original checkout clean.

Validation: full suite 1,945 passed with one existing skip; focused rebrief cases, check, build, built smoke and installed-archive package test passed. Check reports 45 pre-existing warnings and zero errors. The private state and Codex platform path were exercised without credentials, model calls, hooks or live mutations.
