# Why serve separates content from rendering

Decision context: owner API-first direction and consolidation, 2026-11-18.

Backend services already own rules, workflow facts and effective configuration.
Having pages reconstruct that content creates a second authority. Versioned APIs
let web components render the same domain content that other transports use,
while frontend components own interaction, loading states and markup.

The [serve transport audit](../reports/serve-http-mcp-audit.md) records earlier
transport concerns. It is historical evidence, not a benchmark demonstrating that
a particular frontend framework is faster or more attractive. The Work preview is
an incremental visual experiment, not authorization for a wholesale rewrite.

The accepted boundary is defined in [architecture](../architecture.md) and the
[API-first contract](../design/serve-api-first-frontend.md). Existing generated
pages are migration debt; new or migrated pages follow that boundary. This note
contains no new runtime implementation or empirical performance claim.
