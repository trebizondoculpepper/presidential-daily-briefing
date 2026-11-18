# Research and decision rationale

[Architecture](../architecture.md) is the main architectural policy. This directory
records why choices were made, with links to evidence and its limitations. Research
proposals do not change policy by themselves.

- [Service and state boundaries](service-boundaries.md): shared typed facades,
  composition and the Git implementation decision.
- [Native policy](native-policy.md): one decision engine across transports.
- [API-first UI](api-first-ui.md): backend content with frontend rendering.

Earlier research remains in the [report archive](../reports/) so published links,
assets and executable examples keep working. Relevant evidence includes the
[Git investigation](../reports/git-control-approach.md),
[rules engine comparison](../reports/rules-language-engines.md),
[rules plausibility experiment](../reports/rules-plausibility.md),
[cache investigation](../reports/incremental-cache-research.md) and
[serve transport audit](../reports/serve-http-mcp-audit.md).

New research belongs here. Record the question, date, sources/method, findings,
limitations and resulting decision or open question. Keep executable examples
under their existing TypeScript validation boundary. Link an accepted decision
from architecture or its detailed contract; do not copy competing policy here.
