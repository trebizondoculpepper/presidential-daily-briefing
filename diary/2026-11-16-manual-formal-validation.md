# Manual formal-comprehension validation (#703)

The owner clarified that exhaustive research preparation is a special local-only check for rules-engine design and experiment validation, not a CI unit test. Moved the validator to an explicit .manual.ts file and added an opt-in configuration/command. Normal discovery remains *.test.ts; no CI workflow or timeout was expanded. Documented exact invocation and when to run it while preserving native rules, product and package CI coverage. This fix is separate from the owner-held human-ownership contract PR #671.

Validation: normal discovery excludes the manual file and retains native rule tests; explicit manual discovery selects four checks. Manual validation passed all four locally in 15.46s. Normal suite passed 2,401 tests (one skipped); checks, build and CLI help smoke passed. No claim is made that the whole suite is now fast: this change removes the exhaustive research setup and its timeout from normal CI.
