# Central architecture and review guidance

Consolidated cross-cutting principles in doc/architecture.md: canonical shared
services, explicit scoped state holders, composition, thin controllers, typed Git/GH,
native decisions, evidence boundaries and API-first rendering. AGENTS.md is a short
entry point; operational instructions remain in doc/agent-workflow.md. Detailed
contracts refine the central guidance.

Added doc/research with decision rationale and an index of existing evidence,
keeping historical report links and executable examples intact. Codex review rules
and CodeRabbit configuration reference the same architectural review prompt.
Official provider documentation was checked for the supported entry points.
No runtime migration or universal automatic enforcement is claimed.

Validation: full check passed (existing warnings only), 2,914 tests passed with
one skip, build and built CLI help passed. CodeRabbit configuration validated
against its official schema, and local documentation links resolved.
