# Minimum context for a new PDB agent

Bounded research for #350, 2026-11-15. Sources are the current CLI/config help,
`src/config/identity.ts`, `src/config/configcli.ts`, `src/mcp/server.ts`, the
identity/rules/serve contracts and existing platform acceptance reports. This
pass made no client configuration changes, model calls or live workflow writes.

## Finding

Installation, a connected MCP tool, and an agent having read project instructions
are different states. PDB currently has a supported identity initializer and
role-based reads, but they do not by themselves establish minimum agent context.
The owner selected an explicit short copyable web prompt plus a durable small
AGENTS.md section, rather than a full rules snapshot pasted into every context.

The minimum is six linked pieces:

| Context                           | Why it is needed                                            | Source of truth                               |
| --------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Project and PDB purpose           | Prevent cross-project work and explain why use PDB          | Verified selected project; CLI help           |
| Current rules                     | Know actual eligibility/priority policy, not a dated manual | `pdb rules` and shared rules page (#416/#392) |
| Own identity and role             | Focus owned/addressed work without borrowing a name         | Shared identity/config service                |
| Getting next work                 | Use one ranked queue and its next action/detail links       | CLI/MCP briefing services                     |
| Supported fallback/help           | Recover when MCP or a view is unavailable                   | CLI help, config help, process guide          |
| Persistent session-start reminder | Preserve this knowledge across sessions                     | Small idempotent AGENTS.md section            |

Do not put the full policy, every CLI flag, infrastructure details, credentials,
raw snapshots or platform-adapter surveys into the copied prompt. Do not assume
that a reported agent name establishes authority. The first useful work action is
normally a role briefing, not a manual repository-wide GitHub crawl.

## Verified current paths and gaps

`pdb config get identity.name` reads the selected local entry without creating one.
`pdb config set identity.triage_role implementer` (or designer) initializes a missing
entry with one generated name. Explicit `--entry`/`--harness` disambiguate selection;
the commands must run in the matching verified checkout. Repeated initialization
preserves the name. These are actual current help/code paths, unlike the planned
`setup identity` convenience command (#314). A prompt must not advertise that
planned command as already delivered.

The current read interfaces include `pdb --repo owner/repo --role implementer
--agent NAME` and `triage_briefing`. Designer is also supported; human-role work
has its own contract/implementation. Templates must use the capability set of the
running version and label missing features, rather than fabricate a working call.

`pdb process` is the short registered workflow guide. It is not the complete formal
policy. #416 supplies the pure mechanical English compiler; onboarding that promises
the full rules must depend on that delivery and must not quietly substitute process.

MCP client configuration/tool discovery does not prove the model read server
instructions. Client support and visibility are tested separately. The copied
prompt is an explicit path into agent context; MCP initialization instructions and
tool descriptions can provide a short pointer, but are not universal enforcement.
The existing Codex, Claude Code and Ori reports remain the client evidence base.

## Recommended first delivery

Use one pure onboarding document builder for a local `pdb onboard` read, the web
onboarding page, copyable prompt and optional persistent guidance installation.
Keep the prompt short and link to the detailed onboarding/current rules. Give the
existing working identity path until the convenience helper ships, then use the
same registered help source to update examples. Add no new identity backend.

Persist only stable links and coordination/help instructions in AGENTS.md, with
“read current rules at every session start”. No automatically copied full rules
or requirement to refresh that snapshot on every policy change. The web page is
read-only; an explicitly instructed agent or explicit CLI installation does the
file update while preserving unrelated text. Consumer repositories use the same
path, without personal infrastructure or an external communications service.

Optional first-use CLI hints must be one short stderr pointer, not a repeated
footer or a new JSON field. Store per-user/project/version hint state separately
from repository config and identity, and never call it proof instructions were
read. MCP protocol stdout remains clean. A standalone onboard/help request remains
available every time, regardless of hint state or client notification support.

## Fresh-agent walkthrough and limits

1. User selects project and copies the prompt from the server's setup page.
2. Agent opens onboarding and current rules using the actual project URLs.
3. Agent reads/reuses its own identity; on a missing entry it invokes the delivered
   config initializer with an explicit role and unambiguous entry, then reads name.
4. Agent updates the project's PDB guidance section once, preserving unrelated text.
5. Agent requests its named/platform-focused role briefing through MCP or CLI and
   follows the ranked action/detail commands with the normal claim guards.

This is a reproducible acceptance plan, not a claim that a new real-client model
trial ran in this research pass. Implementation tests must exercise those inputs
with fixtures; representative real-client acceptance then records visibility and
read behavior. Missing server, unavailable rules, ambiguous identity, wrong checkout
and existing/malformed guidance all need explicit recovery instead of guessed state.

The concrete contract is [agent-onboarding.md](../design/agent-onboarding.md).
#351 implements the CLI/context path; #391 implements the web page/prompt, reusing
the rule renderer/page and native client acceptance results.
