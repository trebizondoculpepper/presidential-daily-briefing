# General service and state guardrail

Captured the owner's request to prevent distributed integration touchpoints from
recurring beyond Git/GH. Shared capabilities have one canonical typed boundary;
retained mutable state has a named scoped holder and explicit lifecycle. The
contributor guide now makes this a design/review requirement, while preserving
pure helpers, current state components, layout rules and narrow script exceptions.
No runtime migration or claim of universal automated enforcement is included.
