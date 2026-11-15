# Packaged native hook contract (#398)

Recorded the owner's forwarding-only wrapper decision as a separate proposed CLI
contract before behavior changes. Proposed native stdin/output framing remains in
the installed package, reusing #506 and the #398 adapter. The existing trusted
trial definition is preserved. Native happy-path receipt was observed separately;
this proposal does not promote untested boundaries or renew the trial allowance.
No TODO.md exists in this checkout.
