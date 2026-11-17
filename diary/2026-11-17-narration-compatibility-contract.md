# Clarify narration compatibility before implementation (#578)

Implementation review found two existing boundaries worth making explicit before
shipping: v1 project preferences have an exact closed schema, and project files
pin the shipped base rulesHash. A new purpose must not silently broaden v1 or
invalidate pins despite unchanged decisions.

The focused amendment specifies a separate nullable narrationHash while retaining
every previously hashed field in rulesHash. It permits project-purpose metadata
only through explicit source format 2, preserves v1 and its starter, and retains
all execution/grounding/authority limits. Both revisions remain checked on the
compiled English model. This is contract work only, not delivery of #578 runtime.

Validation passed: check (zero errors, 54 existing warnings), all 144 test files,
2,649 tests passed and one skipped, and build. A prototype comparison also proved
that removing only the new narration fields preserves the legacy hash inputs
byte-for-byte, retaining rulesHash 017d781821f07a45492b8aff30d69cfc06d33dcbc938f86465c0a1c3301eb0a8.
