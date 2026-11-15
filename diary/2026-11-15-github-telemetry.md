# Request telemetry planning

Specified #293's response-header/body evidence boundary and safe per-request
diagnostics, including RATE_LIMIT/RATE_LIMITED and contradictory quota signals.
Kept existing injected Query/REST interfaces compatible and excluded raw private
payloads, credentials and speculative retry claims. This contract does not change
collection, retries or credentials. Synthetic fixtures will represent observed
failure shapes without committing live snapshots.
