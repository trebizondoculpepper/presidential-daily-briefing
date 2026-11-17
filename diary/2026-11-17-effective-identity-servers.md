# Effective identity at local server startup (#677)

The shared identity service now prepares one explicitly selected local project before
stdio MCP or HTTP begins serving. Reads resolve existing bindings only. Tool arguments,
HTTP filters, client names and selected projects remain display context and cannot
initialize another identity or replace trusted startup authority. Startup creation is
retained as historical metadata; subsequent reads report reuse.

Actual bounded MCP responses, events and HTTP JSON carry effective identity separately
from existing attention and selection payloads. HTTP account observations update human
metadata after real authentication checks, preserving last-known outage context and
refusing to revive an account after credential rejection without fresh verification.
No additional account registry or authentication requests were introduced.

Rebrief reuses verified session bindings through the same service in readonly mode;
its temporary continuation state and native Codex response framing retain their existing
contract. Explicitly disabled human lookup does not inspect a previous account cache.

Disposable-project tests exercise real stdio startup/restart framing, SDK MCP requests,
ephemeral HTTP and HTTP MCP, bounded projection, startup failures after persistence,
missing auth/role, multiple projects, readonly focus, account switches and recovery.

Validation on the fixed implementation: check passed (zero errors, 54 existing
warnings); all 144 test files passed, 2,649 tests passed and one was skipped.
Build and credential-free smoke passed. Package validation includes installed native
adapter framing and MCP round trips. An earlier in-flight development run saw a new
test against an earlier imported module; the complete fixed-tree rerun passed.
