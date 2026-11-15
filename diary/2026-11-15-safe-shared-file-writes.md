# Shared JSON and lock safety contract (#382)

Read #203's real-process storage findings, atomicJson, update-cache and shared
filelock callers. Wrote a docs-first contract removing age-based lock stealing,
retaining caller-specific state semantics and exposing release/cleanup failures.

Corrected the informal crash expectation: failures before rename preserve old data;
after the commit point the new file may be visible with durability unconfirmed.
Concurrent full snapshots cannot be merged like update-cache channels, and checkpoints
still advance only after complete live output. No production storage was touched.
