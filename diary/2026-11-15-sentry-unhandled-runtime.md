# Optional Node crash reporting

Implements the merged #623 contract. The SDK is opt-in through SENTRY_DSN, with
SENTRY_DISABLED=1 escape hatch. Only real executable bootstraps initialize it; mode
is cli/serve/mcp. Default integrations and other telemetry collection are disabled;
fatal events pass through a fresh allowlisted serializer. Normal handled command
errors retain their existing path. No DSN or authentication data is committed.

Focused tests validate event minimization, trusted source containment, disabled
configuration and actual unhandled-rejection envelope/exit behavior. A disposable
external preload triggered an exception only after the built serve /healthz returned 200. The process exited 1, SDK ingest responded 200, and Sentry issue
PRESIDENTIAL-DAILY-BRIEFING-1 confirmed the fixed safe title. No permanent test endpoint
or trigger exists. External preload frames are intentionally filtered; this does not
prove production source-map readability. Production/release setup remains a follow-up.
