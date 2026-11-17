# Running-process footer (#730)

Implemented one shared footer fragment at the served HTML response boundary,
preserving each page's existing safety text. Startup identity is copied once,
with installed-package gitHead when available, unknown dirty provenance unless
provided by trusted build metadata, and no network IP discovery or Doctor dependency.

Validated shared rendering and route/status integration with injected metadata;
full check, 2541 passing tests/1 skipped, build and installed-package checks passed.
Synthetic Quotas visual QA passed at 1280x1000 and a verified 390x1100 CSS viewport;
390px document scroll width matched the viewport, with readable wrapping. No
screen-reader/audio claim. Disposable server/browser profiles were used.

## Morning integration

Merged main through 3f935f7 into the footer branch after overnight identity and
diagnostics changes. Kept both startup identity preparation and immutable process
metadata capture, and retained both README explanations. Check and build passed;
the combined normal suite passed 2,685 tests with one existing skip. No user
server or global installation was changed.
