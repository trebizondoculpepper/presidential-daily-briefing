# Agent onboarding and persistent coordination guidance

Contract for #351 and #391, based on #350 research and the owner's 2026-11-15
copyable-prompt decisions. This is planned interface behavior, not a claim that
`pdb onboard` is already installed. Existing accurate commands remain available.

## New owner-approved onboarding-file direction

[Onboarding rules files](onboarding-rules-files.md) supersedes the default read-only
local CLI behavior and earlier no-snapshot/optional-section requirements for the
new delivery: normal verified-project `pdb onboard` generates managed `rules.md`
and its AGENTS.md reference. Existing safe-write, identity and read-only transport
boundaries remain. Until that implementation lands, current CLI behavior still
applies. The npm postinstall hint is a separate small ticket.

## Shared document

Create one typed pure document builder with verified project context, available
CLI/MCP capabilities, optional actual server origin, role/identity-selection hints,
and current policy identity. It returns purpose, current-rules reference, identity
instructions, briefing/help examples, a short copyable prompt and the persistent
guidance section. No issue body/comment or arbitrary external content can insert
instructions into this document. Transport projections reuse the builder.

**Owner decision (#391, 2026-11-15), superseding the next paragraph and any mandatory AGENTS.md edit:** the copyable prompt is at most ten lines. It explains PDB and basic use, tells the agent to read the project rules at the start of every session, links onboarding/help and identity setup, and says to use PDB for coordination, status and priorities in preference to equivalent `gh` operations. It may suggest recording useful guidance for future sessions; it does not prescribe AGENTS.md contents or instruct an edit. The shipped prompt (`onboardingDocument` in `src/briefing/onboarding.ts`) still has the step "If AGENTS.md has no pdb coordination section, add it"; removing it is an implementation follow-up. `pdb onboard --install` remains an explicit user command.

The copied prompt starts by asking the agent to read onboarding/current rules,
then explains obtaining its own name, choosing CLI or MCP, getting help and updating
AGENTS.md before project work if needed. Require a current-rules check at the start
of every session. Refer to the selected project, not an arbitrary launch cwd.

No full policy snapshot in the copied prompt or persistent section. Generate links
with the validated actual origin/project selector, including IPv6/escaped query
values, not concatenated untrusted Host headers or hard-coded ports. Never include
tokens, credentials, local control capabilities or unrelated absolute paths.

## CLI

Add `pdb onboard [--repo owner/name] [--role implementer|designer] [--json]
[--server URL] [--install]`. Help works outside a checkout and without credentials.
Default operation prints instructions, without writing files or initializing a
name. An explicit repo and no checkout can produce read/remote usage instructions;
local identity/install actions require the verified matching root. A missing target
gives generic help and a project-selection example instead of borrowing another
project's configuration. Do not resolve a default by a hidden rich GitHub scan.

`--server` is an explicit optional validated HTTP(S) origin/reference with no URL
credentials or secret query parameters. When absent, provide CLI rules/help and
do not invent a working web URL. The setup page supplies its own actual origin.
Role/capability examples reflect what is shipped; unsupported roles/selection get
exact help. Identity setup uses the existing resolver/config initializer (or the
delivered setup helper once available), never direct TOML edits or another entry.

Text and JSON render the same versioned document. Keep protocol and JSON stdout
free of unrelated notices. Exit 0 for rendered instructions/unchanged or completed
explicit install; 2 for usage or unresolved project/selection prerequisites; 1 for
I/O, invalid config or failed install. Read-only help must not be denied merely
because identity does not yet exist: explain the correct creation path.

## Explicit persistent section

`--install` writes only the verified project's root AGENTS.md and only the managed
PDB coordination section. It does not run claims, initialize identity, change client
settings or modify other project configuration. In the prompt-driven path the agent
is explicitly instructed to perform the equivalent small guidance update.

Use stable markers `<!-- pdb:coordination:start -->` and
`<!-- pdb:coordination:end -->`. The block contains selected-project references,
current-rules and onboarding links when available, exact CLI/MCP/help pointers and
the session-start rule-read requirement. Do not freeze full rule prose or a transient
agent name into shared instructions. Markers identify the block; version/hash data
describes the generator, not proof that any agent read it.

Preserve bytes outside the section and make repeated identical installation a
no-op. Detect missing paired/duplicate/nested markers and refuse destructive repair.
An existing unmarked dedicated PDB section needs a proposed patch/recovery rather
than silent duplication or overwrite. Distinguish an existing lowercase agents.md
from absent AGENTS.md on case-sensitive filesystems; do not create conflicting
copies. Preserve the existing file rather than rename it implicitly.

Use injected filesystem boundaries, a bounded safe lock and intervening-edit
checks around an atomic same-directory replacement. Never break a lock by age.
Refuse a symlink/path that would write outside the verified root and report I/O
conflicts without losing previous content. A new file is an intentional local
project change, not automatically committed. Do not print raw private files on error.

## First-use and MCP delivery

Put a brief setup pointer in CLI help and the existing MCP briefing tool description.
Provide short server initialization instructions where the SDK supports them, using
the same document source. Treat model visibility as client-dependent, not a server
promise that merely connecting invokes instructions or edits AGENTS.md. There is
no portable MCP server-installed stop hook in this feature.

A first-use hint for ordinary CLI text is at most one short stderr pointer per
project/CLI-version or explicit onboarding reset, stored in a small per-user cache
record. Suppress hints for JSON/protocol output and explicit help/process/onboard
requests. Failure to persist the hint cannot fail an otherwise valid briefing.
No repeated guide footer, background fetching, global settings mutation or special
agent-name assumptions are needed. `pdb onboard` always works independently of hints.

## Web page and prompt

#391 provides a read-only onboarding/setup page using the shared document. Project
selection determines links, supported role examples and connection configuration.
Provide a copy control plus selectable plain text, accessible without clipboard
permission. The copied text must be short, put onboarding/rules first and retain
the persistent-section/session-start instruction. Never install from a GET or
silently register a client. Label unverified platform examples and unavailable
capabilities accurately.

The web page requires the actual rules page rather than a dead link or unrelated
process summary. #392 and #416 provide that prerequisite; CLI onboarding need only
the local full-rules command. Full client configuration automation and future
CLI/MCP capability parity are not prerequisites for a useful prompt.

## Implementation status (#351)

Shipped: the pure builder (`src/briefing/onboarding.ts`), `pdb onboard` with `--repo`,
`--role`, `--server`, `--install` and `--json` (`src/briefing/onboardcli.ts`), the managed
section writer (`src/config/agentsguide.ts`, over the locked atomic `updateTextFile` of #382),
the help and `triage_briefing` pointers, MCP server `instructions` from the same document, and
the first-use stderr hint. The hint is keyed by `--repo` or the checkout root plus the CLI
version, stored in `onboarding-hints.json` in the per-user cache, offered only for plain-text
briefings, and disabled by `PDB_NO_FIRST_USE_HINT` (set by the test, smoke and package runs).
#391 added the read-only `/setup` page of `pdb serve` (doc/design/serve.md), rendering the same
document with the server's origin; with a server, the prompt links the project's `/setup` and
`/rules` pages first. Not yet shipped: an explicit hint reset command.

## Acceptance

Test missing and existing identity, ambiguous harness, wrong project/root, no
server, unavailable formal rules, fresh/existing/manual/malformed AGENTS guidance,
repeat install, concurrent edits and case/symlink boundaries using temporary roots.
Compare CLI/JSON/web content from one builder, verify correct real-origin/project
links, actual supported command examples and no embedded secrets. Test stdout
cleanliness and first-use suppression/no-op behavior. CLI and web default reads
must not write files or query issue history.

Record one representative client walkthrough separately if it is run; template
tests prove content/commands, not that all models obey the prompt. #350's report
is bounded research, not empirical agent-adherence evidence. Do not delay the
urgent standalone rules compiler waiting for onboarding or a web UI.

## Human-operated observations

An agent identity is optional for observational reads. A human can run
`pdb --role implementer` or `pdb --role designer` to inspect work without creating
an agent or choosing among configured entries. Existing explicit/verified agent
identities may personalize the view. Claiming or submitting work still requires
agent attribution. See [effective identity](effective-identity.md#read-only-operations-and-service-execution)
for the shared boundary and #865 for implementation.
