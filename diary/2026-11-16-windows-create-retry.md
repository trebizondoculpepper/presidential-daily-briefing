# Windows exclusive-create retry contract (#729)

PR #744's bounded run reproduced four failures with the merged diagnostics: safe JSON batch 36
and cache-storage batches 26, 42 and 46 all reported immediate create-phase EPERM. The cache
workers retained the complete factual failure, with fourteen writes instead of fifteen in each
failed worker. The old helper treated that code as terminal before any bounded retry.

Recorded a focused contract extension before changing production behavior: retry only Windows
exclusive-create EPERM inside the existing caller deadline, retain permanent failure evidence,
and preserve exclusive flags, tokens and non-stealing release semantics. No assertion that a
specific Windows component caused the refusal is justified by these logs. The next repair run
must count real refusals followed by successful writes, then restore normal repetition counts.

#677's contract merged as 27f05a7, but its runtime work was released incomplete to prioritise this
own-PR failure. Its isolated worktree retains only a small IdentityWriteOptions interface starter;
no effective-identity runtime delivery or completion was claimed. No root TODO.md exists.

Contract validation: check/build passed and all 135 baseline test files passed
(2,509 tests, one skipped), using one worker with existing per-test limits.
