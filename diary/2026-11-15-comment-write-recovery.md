# Workflow comment recovery design (#345)

Prepared a docs-first contract for an estimated ticket missing readiness state.
Read the current estimation GraphQL writer, claim plan executor, delivery operation
identity and merged #293 telemetry contract. Checked official GitHub retry guidance;
no live write or induced throttling was used.

The design preserves command-specific guards/order and partial writes. Only explicit
throttling refusals can cause one automatic retry, with response-bound timing,
abortable waits and fresh preconditions. Lost-response read-back can confirm success,
but an absent receipt does not justify a blind repost. Existing opId/semantic parsers
remain authoritative; no exactly-once claim or new signature scheme is introduced.
