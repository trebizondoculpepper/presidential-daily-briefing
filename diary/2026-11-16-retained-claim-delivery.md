# Retained-claim implementation follow-up (#413)

Picked up the released ticket and its existing PRs #606/#608, preserving the original
commits and merging current main without rewriting history. Ranking corrections deny
new pickup for every incomplete ownership inventory, including observed waits. The
zero-observed case emits a native repository-context inspection with a team command;
no GitHub issue, claim or ownership is fabricated. Both engines and compact/web
presentation support that action, while legacy ticket-subject projections stay typed.

Tests cover zero subjects, incomplete inventories containing known waits, complete
waiting inventories still permitting pickup, CLI rendering and native rule audience.
Existing shortlist/activity fixes are verified before clearing their review threads.
The generated policy/English and parity artifacts change intentionally with the rule.

## Team and diagnostic projections

Finished the stacked projection slice: failed live claim-activity reads now mark both team and who reports incomplete, including their text output. Live released claims remain visible as annotated snapshot evidence but no longer inflate retained-ownership review counts. Regression coverage exercises real injected read failures and mixed active/waiting/released claims. Existing Ticket Doctor activity-cap omissions remain preserved.
