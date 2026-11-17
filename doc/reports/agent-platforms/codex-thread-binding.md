# Codex execution-thread evidence for identity binding (#677)

Verified against the public `rust-v0.169.0` tag, commit
`d32063f96c2dff1dc96af839b3952abb6acfeda4`, matching the observed local version 0.169.0.
No session values, rollout database or private configuration was read for this check.

The [spawn implementation](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/agent/control/spawn.rs)
associates each child agent with its own newly created thread ID, including fork/resume paths.
The [shell environment builder](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/shell_environment.rs)
applies supplied thread context after environment policy overrides.

The [executor metadata contract](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/exec-server/README.md#command-metadata)
states that current execution thread metadata replaces inherited/snapshot values. It also
limits this to updated executors and describes the labels as correlation rather than authority.
PDB therefore requires a verified current version/signal combination, scopes the digest to the
project, and handles missing/conflicting signals without borrowing a generic identity.

Inference: this per-agent thread context can correlate successive local commands for one
logical agent, including agents sharing a checkout. Root-session and per-call identifiers are
not substitutes. This evidence does not authenticate a caller, identify arbitrary MCP clients,
or verify another harness's session semantics. Server execution context remains local startup
context; display selection cannot become a trusted binding. Older/missing evidence requires
explicit entry selection. No sub-agent was launched to perform this investigation.
