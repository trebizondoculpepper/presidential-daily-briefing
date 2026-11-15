# Explicit MCP issue creation contract (#204)

Prepared the post-CLI MCP wrapper design: one action-specific opt-in tool over the existing shared service, explicit targets, read-only defaults and honest uncertain outcomes. Defined both local stdio and loopback HTTP trust boundaries using existing Host/Origin/JSON checks, without inventing per-agent authentication or a new GitHub credential store. Existing web edits retain their CSRF path. Runtime remains blocked by #199; no write capability or client setting was enabled.
