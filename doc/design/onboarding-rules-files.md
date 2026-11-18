# npm onboarding hint and generated project rules

Owner-approved direction, 18 November 2026. Supersedes only the read-only default
and rules-file/persistent-section portions of [agent onboarding](agent-onboarding.md)
once implemented. Contracts are not shipped behavior. The npm hint and project
file generation are separate implementation tickets: #1026 and #1027.

## Minimal npm install hint

After package installation, the optional npm `postinstall` hook prints one line:
"Run pdb onboard in your project for onboarding instructions."
This is for `npm install -g @trebizondoculpepper/presidential-daily-briefing`, not
`pdb install codex`/`claude`. It does not run onboarding automatically.

Keep the hook trivial: installed Node prints a static hint. No network, Git/GH,
telemetry initialization, identity lookup, shell-dependent commands, interactive
prompts, client configuration or project writes. Do not require tsx, a checkout or
other devDependencies. A literal Node print in the required package manifest is
sufficient; do not add handwritten application JavaScript or a new installer
framework just for this message. If an executable source module is introduced,
it follows the TypeScript/build/language policy and ships in the package.

A clean source checkout's `npm ci` must work before dist exists. Package-install
failure must not be introduced by an optional missing build artifact. Test the
actual packed install and clean-checkout lifecycle as appropriate. No changes to
user npm settings: scripts may be disabled and output may be suppressed. The
README and existing help remain alternative entry points. No promise of universal
postinstall visibility. [npm lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts)
explains that npm may run hooks in the background and supports disabling scripts.

## `pdb onboard` in a verified project

Owner explicitly requests that normal onboarding now generate `rules.md` and update
only PDB's coordination section of `AGENTS.md`. Existing `--install` remains an
idempotent compatibility alias for these same writes, not a second writer.
Add `--dry-run` to show the exact proposed file actions without writing.
`--help` remains read-only and works without identity, credentials or a checkout.
`--json` chooses structured presentation, not implicit read-only/dry-run behavior;
report file outcomes explicitly. No identity creation or client/MCP installation
is added to onboarding. MCP/serve onboarding reads remain non-writing; this new
mutation is the explicit local CLI invocation only.

Resolve the target via the existing typed Git/config service and verify any explicit
repo matches the local checkout. An outside-checkout invocation may still print
generic/read-only remote instructions; it must not select an arbitrary registered
project or create files there. Explain how to run in a verified checkout. Do not
fetch a full repository ticket inventory merely to generate guidance.

## Shared Markdown prerequisite

[Markdown rules](markdown-rules.md) (#1049) supplies the common renderer for #1027.
Do not create a second formatter while that prerequisite is pending.

## Generated `rules.md`

Render the effective current rules through the same transport-neutral document and
English generator used by `pdb rules`, including enabled project policy/narration.
Do not run an LLM, copy static prose from these contracts or maintain a second
English rule source. Include generator/schema version, effective rules hash,
narration identity when available, scope and a clearly labelled generated header.
Exclude live ticket data, agent names, credentials, private config and absolute
checkout paths. No fake claim that every workflow obligation is formalized.

The file is a refreshable snapshot. Its header says to regenerate with `pdb onboard`
and consult `pdb rules` for current policy. Keep generated content deterministic for
identical input; do not rewrite just to bump a wall-clock timestamp. The managed
AGENTS block links `rules.md`, identifies it as the project's generated PDB rules,
and retains session-start current-rules checking. Do not copy the whole rules body
into AGENTS.md or silently override higher-level architecture instructions.

## Safe file ownership and partial outcomes

Reuse the existing managed block markers, verified root, injected filesystem,
bounded lock, revision/intervening-edit checks and atomic replacement conventions.
Preserve bytes outside the PDB block, existing case-sensitive `agents.md` handling,
symlink restrictions and malformed/duplicate marker refusals. No automatic git
commit/push. Explain these are project files the human may choose to version.

Create an absent rules.md or update a recognized unmodified PDB-generated file.
Store a content fingerprint in its generated metadata so manual edits are detected;
unknown/unmarked files or case-colliding Rules.md are conflicts. Never overwrite
user rules merely because the filename matches. Preserve edited generated files
and show a safe recovery/preview; no silent backup/rename or destructive --force
behavior in this ticket. Existing onboard guidance for AGENTS collisions remains.

Preflight both proposed files before any writes. There is no atomic two-file Git
transaction: report each actual result (`written`, `unchanged`, `refused`, `partial`
or unknown) and a useful retry. Prefer writing rules.md successfully before adding
its AGENTS reference; if that first write fails, do not create a broken link.
If AGENTS writing fails afterward, preserve the generated file and report partial
completion. Idempotent retry reconciles existing content rather than overwriting
intervening edits. Preserve existing JSON fields and add a versioned file-results
section; stderr carries notices, never corrupting stdout JSON.

## Acceptance

npm hint and onboarding-file tickets remain independent after this contract; one
must not wait for the other. Focused checks verify actual package hook behavior,
no source-install regression, generated document parity, marker/content ownership,
case collisions/symlinks, dry-run/no identity, repeat no-op, concurrent edit refusal
and both partial-write directions. No MCP installer, new language runtime, full
rules engine experiment or broad redesign belongs in these two tickets.
