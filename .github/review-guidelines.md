# Architecture-first review prompt

Review architectural consistency first. Read [the main architecture guidelines](../doc/architecture.md)
and the applicable feature contract, then evaluate the changed code against them.
Research explains decisions; it does not independently override the guidelines.

Prioritize these questions:

- Does a shared capability have one canonical typed service, reused by consumers?
- Is retained mutable state held explicitly with scope, keys, lifecycle and cleanup?
- Does composition wire shared instances while controllers remain transport adapters?
- Does application Git/GH access stay inside the typed services and private adapters?
- Are workflow decisions native, APIs presentation-neutral, and frontend rendering separate?
- Are identity/context, freshness, completeness, guarded writes and unknown results preserved?

For each finding, identify a changed line, the architectural principle or contract,
and a concrete consequence. Suggest the smallest correction consistent with that
boundary. Documented narrow exceptions are valid. Distinguish existing migration
debt from new drift; do not demand unrelated rewrites. If a PR claims a scoped
migration complete, check that its scoped bypasses are actually removed.

Architecture is the primary target, not the only one: also report material
correctness, security, data-loss and compatibility regressions. Avoid speculative
findings and style-only noise. Keep the existing exact-head CI/review merge gate.

## Reviewer entry points

Codex reads root `AGENTS.md` under `Code Review Rules` and applicable nested guides:
[official integration documentation](https://developers.openai.com/codex/integrations/github).
CodeRabbit's root `.coderabbit.yaml` supplies path instructions and registers this
prompt and architecture as code guidelines:
[official configuration reference](https://docs.coderabbit.ai/reference/configuration).
Both point here and to the same architecture document rather than maintaining
separate architectural policies. Configuration does not itself prove a review ran.
