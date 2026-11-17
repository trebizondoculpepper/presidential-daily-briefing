# Complete the documented PDB rollout audit (#320)

Rechecked the canonical repository and registry rather than relying on the earlier
0.9.0 report. npm latest is 0.12.0 at gitHead 3309475. An isolated global-prefix
install, explicit-executable npx help, persistent setup/reuse in a disposable Git
project, live read-only briefing and real MCP stdio handshake all succeeded.

Current source b0d580d additionally bootstrapped a name on a normal live briefing
in a separate disposable checkout under controlled supported-session signals.
The next invocation omitted agent, entry and role, reused that exact name and left
the private identity file byte-identical. Both reads exited 0 with separately
resolved current human context.

Applied the existing approved eight-category rename map. Corrected stale usage
claims about planned identity/MCP/release features, removed the blanket assertion
that setup is unsupported, and distinguished current source from older published
identity flows. The inherited CLI proposal points to current executable guidance.
Preserved protocol keys, aliases, historical reports and legal attribution; the
license transition remains separately tracked in #634. Nothing was published or
installed over the user's existing commands.

Relative documentation links resolve. The public project website returns 200;
the npm HTML page refuses automated fetches with 403, while registry metadata,
tarball installation and npx succeed. Do not describe that HTML page as browser
verified.

All source validation passed: check has zero errors and 54 existing warnings;
144 test files passed, 2,649 tests passed and one was skipped. Build, smoke and
package tests passed. CONTRIBUTING's active old-slug link and pending-audit wording
were corrected to the already established gate and audit result.
