# Project source boundary (#514, part 1)

Implemented only the filesystem/header/canonical parsing stage of the reviewed native project-rule format. Reads the fixed selected-root file through injected I/O, limits bytes and pre-parser nesting, rejects duplicate map keys and incompatible metadata, normalizes map order and returns a source fingerprint. Errors omit raw source and I/O payloads.

The return type is deliberately ParsedProjectSource with phase parsed-source and unknown native bodies. It is not a validated policy or activation route. Full helper/preference grammar, grounding/cycle/lexicon/English validation and the final effective-policy artifact remain #514 part 2; worker execution and integration remain #515/#516. No CLI/server import, config write, native policy activation or model call was added.

Focused tests include actual temp-file reads and POSIX internal/escaping symlinks, injected cross-platform sibling escapes and failed reads, CR-comment depth bounds, node/vector counts, UTF-8 size boundaries and canonical digest invariants. Windows directory-open errors may be unreadable instead of non-regular; both are explicit refusals. The native inequality contract typo was corrected separately in merged #521.
