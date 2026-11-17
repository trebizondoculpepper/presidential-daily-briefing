# Effective identity preparation core (#677)

The merged #742 contract separates local execution selection from display focus and the
employing human. This slice implements its shared preparation service, without enabling
bootstrap in transports yet. #677 remains open for CLI/MCP/HTTP integration and onboarding.

The existing private identity writer now persists a session binding and identity coherently
under its existing lock. Concurrent first use converges on the winning name and stored role;
per-call roles remain overrides. A concurrent name correction is reused instead of writing
back an earlier snapshot. Explicit rebinding uses the observed binding as a compare
and swap guard. Unbound generic/legacy entries require explicit selection, and a dangling
binding is never permission to allocate a replacement.

The registered Codex provider uses project/repository-scoped opaque thread digests and a
version gate backed by pinned upstream source evidence. It does not use shared session or
per-call IDs, expose raw thread IDs, authenticate callers, or infer another harness's agent.
Missing/conflicting evidence retains explicit entry selection.

The preparer composes the existing human resolver and initializer. It distinguishes reuse,
creation, one-time import, proposed setup and partial/uncertain persistence. A new name needs
an explicit role. Read-only and dry-run preparation allocate nothing and write no exclusions.
Typed authentication refusal is reported separately from an outage or last-known human.

Targeted tests exercise real disposable files with injected Git, allocation, environment and
human boundaries: concurrent same/different agents, stored-role preservation, account/repository
switches, ambiguity, malformed/tracked/symbolic targets, missing role/authentication, legacy
import, dry-run and post-rename failures followed by non-allocating retries. No live private
identity was used or written by these tests.

Validation: `npm run check` (zero errors; 54 existing warnings), `npm test -- --maxWorkers 1`
(140 files, 2,590 passed and one skipped), `npm run build`, and a targeted rerun of 88 identity
tests after the final guard adjustment. The normal Vite+ pre-commit hook runs on commit.
