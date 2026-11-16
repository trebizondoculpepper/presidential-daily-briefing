# Formal comprehension Windows release blocker

Two main CI runs hit the offline preparation hook's 60-second timeout on Windows.
Reuse the engine result that validates each native scenario in the formal-projection
comparison, removing one redundant evaluation per case without dropping coverage.
The exhaustive integration hook gets a bounded three-minute Windows budget; global
unit-test limits remain unchanged. This is preparation/scoring only, with no model calls.
