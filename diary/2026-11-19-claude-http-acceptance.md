# Bounded real-Claude HTTP MCP acceptance

Executed the owner-approved native Claude Code trial using isolated settings and
the existing authenticated client. Role views, unattributed human reads, detail,
cache reuse and same-client server-restart recovery were observed. Second-project
acceptance failed at the engine's 500-subject bound; the result is conditional,
not a completed #395. A model-free HTTP read exposed the specific capacity error
that MCP's generic engine-failure message hid.

Claude reported eight turns despite the requested six-turn flag, and about USD
0.175 in list-price usage, below the USD 3 allowance. No additional paid trial or
retry was run. No normal client configuration or GitHub state was changed by the
trial; only the private owned server was restarted and then stopped. Recorded
sanitized evidence in the platform report, without publishing raw responses or
credentials.
