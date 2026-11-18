# Why workflow policy is shared

Decision context: consolidation of existing contracts, 2026-11-18.

CLI, MCP and web views must agree about eligibility, ownership, ranking and
completion. Reimplementing those decisions in each transport produces contradictory
advice and makes policy changes difficult to verify. The accepted architecture
uses one native rules engine; TypeScript collects facts and performs mechanics.

The [engine comparison](../reports/rules-language-engines.md) and
[plausibility report](../reports/rules-plausibility.md) record the earlier selection
and experiment. Their bounded findings are evidence, not proof that every scenario
is covered. Native EDN scenarios and focused integration checks remain necessary.

[Architecture](../architecture.md) states the boundary. The
[rules contract](../design/rules-component.md) defines its implementation detail.
This rationale adds no new ranking rules or runtime behavior.
