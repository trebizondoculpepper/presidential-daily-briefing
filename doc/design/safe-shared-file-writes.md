# Safe shared JSON writes and non-stealing locks

Contract for #382, based on the bounded #203 storage experiment. Harden existing
snapshot/checkpoint/update-cache writes and the shared lock release boundary; do
not introduce a new persistent evidence cache, database or background service.
Reuse the experiment's validated sequence with production adapters and tests.
This contract supersedes age-based lock breaking in updates.md/identity.md when
implemented; existing runtime behavior is not changed by merging documentation.

## Lock ownership

Cooperating writers acquire an exclusive per-target lock before reading state to
modify it. Use a fresh unpredictable ownership token and exclusive creation; never
infer ownership from a PID alone. Wait only within the caller's existing bounded
budget: optional update checks retain their short skip behavior, explicit writes
report a conflict on timeout. Cancellation stops new attempts. Independent target
files do not serialize behind a global lock.

Never remove or take over a lock because its timestamp is old, its PID is absent,
or a clock moved. An old-looking holder may be slow, paused or on another platform.
A crashed holder therefore leaves a stuck lock. Report that distinction and a safe
operator recovery path: stop/verify writers for this exact target, inspect the lock,
then remove it deliberately. Do not automatically run a shell deletion, signal the
holder, scan arbitrary directories or claim that a PID proves liveness/death.
Readers need not acquire a writer lock and still see complete old/new files.

Only release the lock this writer created and still owns. Missing lock, changed
ownership and actual read/unlink failure are distinct outcomes. Do not silently
swallow permission/I/O failures; surface bounded cleanup diagnostics. Never unlink
a replacement lock. This is a cooperating-process protocol, not a guarantee against
an external process deliberately replacing/unlinking lock files mid-operation.
Ownership loss detected before commit is a refusal, not permission to overwrite.

The shared acquire/release implementation also serves identity writers. Removing
age stealing and exposing cleanup errors must preserve their private-file exclusion,
root/symlink checks, unknown TOML values and existing bounded wait semantics. Do not
migrate identities or rewrite their contents as an incidental lock change. Existing
callers must handle the richer release outcome without losing the primary result.

## Durable atomic replace

Resolve the target in the caller's verified context and refuse unsafe symlink/escaped
writes under the existing target policy. Create required directories safely; do not
follow an unexpected lock/temp link. Within the lock:

1. Read and validate current state. Distinguish ENOENT from unreadable/unsupported
   state. Do not overwrite an unreadable existing file as though it were empty.
2. Compute the caller's intended update against that state, retaining unrelated keys
   and concurrent committed updates according to that store's schema.
3. Create an unpredictable same-directory temporary file exclusively, using private
   permissions where supported. No shared PID-only name or overwriteable temp file.
4. Serialize/write and fsync the temporary file; verify the bytes/parsed value match
   the intended schema/value before replacing the target.
5. Revalidate ownership and the caller's intervening-edit guard, then atomically
   rename over the target. Never unlink the old target first.
6. Fsync the parent directory where supported, then release ownership and clean only
   this attempt's leftover temporary file.

A bounded retry for a platform's transient rename-sharing error is acceptable, using
injected timers and the existing operation deadline; it must not delete the target,
steal a lock or turn arbitrary permission/I/O failures into an unbounded loop.
Unsupported directory fsync is a named durability limitation, restricted to verified
platform-specific unsupported codes. I/O errors are not silently treated as unsupported.
No claim of portable power-loss durability is made without the corresponding evidence.

The commit point is rename. Failure before rename is `not-written` and preserves the
previous target. Failure after rename is `committed-with-error`/durability-unconfirmed:
the new target can already be present, so do not report a definite rollback or repeat
a logical mutation blindly. Cleanup/release errors are additive to that primary outcome.
No failure is hidden merely because the target is readable. On restart, a leftover
private temp/lock is diagnosed, not automatically trusted/promoted/deleted by age.

## Each store keeps its own semantics

The shared helper provides a locked update callback and a typed outcome; it does not
invent one generic object merge for every JSON file.

- Update-check state re-reads under the lock and preserves unrelated channels and
  newer notice/attempt state. Failure can skip the optional check/notice honestly;
  it never prevents useful triage or hammers the registry with automatic retries.
- Full snapshots are coherent replacements, not unions of unrelated issue pages or
  contexts. Preserve schema, repository/auth/profile context and coverage. A stale
  snapshot writer must not replace a newer committed generation; reject or keep the
  newer valid generation according to the existing envelope. If ordering is unknown,
  refuse conflicting replacement rather than claim the older result is latest.
- Checkpoints retain the exact existing schema and repository binding. A candidate
  `through` is eligible only after its complete successful live output was flushed.
  Under the lock, validate the current checkpoint and advance monotonically for the
  same repository; a later successful writer cannot be regressed by an older one.
  Offline/incomplete/failed output never advances. Comparing timestamps alone cannot
  authorize a different repository's cursor or repair an invalid/future schema.
- Other existing `atomicJson` callers, such as explicit plan files, keep their own
  overwrite/conflict semantics; inventory them before replacing the helper. Do not
  silently append snapshots or apply checkpoint monotonicity to arbitrary plans.

'Concurrent writers lose no update' means each accepted logical read-modify-write
is serialized and preserved under its store semantics. It does not mean every full
snapshot is concatenated or that both conflicting values for one key can win.
No new evidence becomes live mutation authority because it was safely persisted.

## Results, compatibility and delivery

Preserve successful output/schema/exit behavior. Add safe typed failure/cleanup
metadata where needed and a concrete target-specific recovery message. Optional
cache failure remains optional; explicit checkpoint persistence failure cannot be
reported as a successfully advanced cursor. HTTP/MCP diagnostics expose categories
without private paths or document contents. Tokens, identity files and live snapshots
never enter tests, logs or Git.

Do not retrofit age-based recovery through another timer, heartbeat or stale filename.
If automatic liveness recovery is later desired, design it separately. The first
version deliberately trades automatic recovery for safe refusal.

## Acceptance

Keep the real-filesystem experiment as prior evidence, not production acceptance.
Use injected syscall/clock failures plus separate child processes and temporary
files on Linux, macOS and Windows in the maintained CI matrix:

- simultaneous read-modify-write processes preserve every accepted record/channel;
  identical targets serialize, distinct targets progress independently;
- old-looking live lock, clock rollback/forward, crashed holder, wait timeout and
  cancellation never steal a lock; changed token is not released;
- release EACCES/EIO and temp cleanup failures are visible, without masking the
  successful commit or original precommit failure;
- process death/failure at each write step leaves old valid state before rename or
  new valid state after rename, never a torn/missing target;
- file/parent fsync failures, verified unsupported directory sync, transient rename
  refusal, unsafe links, unique temp collisions and prior unreadable state;
- concurrent older/newer snapshots, independent update channels, compatible
  checkpoints, wrong repository/schema, incomplete/offline/failed output and
  output-flush failure preserve each store's stated invariants;
- all existing shared-lock consumers compile and retain bounded wait/private-file
  protections; package/CLI behavior and error categories remain consistent.

Do not turn a Windows skip into evidence of Windows durability. If the CI host
cannot exercise an operation, record that explicit coverage gap and keep the claim
bounded. No live cache/identity or operator lock is modified for acceptance.
