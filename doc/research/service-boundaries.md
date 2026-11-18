# Why shared services have one owner

Decision context: owner discussion, 2026-11-18. Git and GH access had spread across
application modules. The accepted response is typed facades, constructed by the
application composition root and shared by consumers. The same principle applies
to future shared capabilities rather than waiting for another scattered adapter.

The [Git investigation](../reports/git-control-approach.md) inventories operations
and recommends retaining installed Git behind typed methods. It does not establish
an empirical comparison of candidate libraries. The owner accepted that choice;
there is no new library adoption in this documentation change.

Retained mutable state needs a named scoped holder so cache keys, cancellation,
invalidation and cleanup have an explicit owner. This is an architectural decision,
not a measured performance result. Existing valid holders count; stateless helpers
need neither a service class nor an empty state wrapper.

See [the governing principles](../architecture.md),
[service composition](../design/github-service-composition.md) and the
[module migration inventory](../design/git-gh-module-migrations.md). The inventory
tracks implementation debt; adopting the principle does not finish migrations.
Standalone/release scripts retain their documented direct-Git exception.
