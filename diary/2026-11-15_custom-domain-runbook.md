# Preserve the public website binding (#622)

Reused the fresh #621 verification evidence and read back the current Pages source,
custom domain, certificate/enforcement, branch CNAME and latest build identity.
Documented the manual-preview state separately from the still-unimplemented release
pipeline, canonical root/nested routes/assets and bounded diagnostic/recovery steps.

Selected the existing #602 design's custom Actions Pages mode: preserve the Pages
control-plane domain setting, without adding CNAME after #601's artifact hashes.
Recorded the distinct branch-mode rule and the requirement for explicit source-mode
rollout. Added preflight/post-host acceptance and partial-outcome handling while keeping
immutable releases and monotonic deployment intact. No workflow, DNS, proxy, hosting
setting, credential or npm release changed. No TODO.md exists in this checkout.
