# Shared GitHub quotas design (#546)

The owner requested both a narrated CLI command and a visual serve page, with no
further product questions needed. Created #546/#547/#548 with impact provenance
and native sequencing. Reviewed current #293 telemetry and passive serve diagnostics
before writing the shared contract.

The new explicit quota API may fetch lazily; existing diagnostics remain passive.
One 60-second in-memory service coalesces requests, preserves per-resource sources
and reset/freshness uncertainty, and never fabricates a secondary-limit percentage.
A visual page is not a new scheduler or authority path. No production credentials,
quota settings, private snapshots, persistent cache or UI were changed here.
