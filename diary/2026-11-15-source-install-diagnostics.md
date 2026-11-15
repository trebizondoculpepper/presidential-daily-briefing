# Source-install diagnostic contracts (#309, #346)

Read current update eligibility/manifest lookup, Doctor's independent checks and
privacy boundary, and the lazy engine error path. Prepared separate delivery contracts
in one shared architecture document so both diagnoses use the running installation,
not the repository being triaged.

Checkout freshness uses only bounded local Git and distinguishes local-ref equality
from remote freshness or built-artifact identity. Dependency checks do not trust a
hidden lock blindly or report all runtime errors as broken rules. Recovery stays
explicit; diagnostics do not fetch, install, rewrite state or change the engine.
