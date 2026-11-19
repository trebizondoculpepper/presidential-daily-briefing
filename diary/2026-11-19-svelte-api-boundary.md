# Svelte and the API-first serve boundary

The owner selected Svelte and authorized the focused dependency/build setup for
the Rules-page migration. Clarified that browser Svelte calls the versioned APIs
on the existing serve origin, while internal Node/CLI/MCP consumers call the same
domain services directly. No extra HTTP loopback/process/port is required.

Updated the architecture, feature contract and shared review prompt together.
Existing pages still migrate incrementally; the Work preview is not automatically
promoted. This is documentation only, not a build or runtime migration.
