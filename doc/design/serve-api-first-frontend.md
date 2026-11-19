# API-first frontend for PDB serve

Owner decision, 2026-11-17; architecture #852 and first migration #853. This
amendment governs new and migrated served pages. It supersedes permission in older
page contracts to assemble HTML/JavaScript strings in backend TypeScript. Existing
renderers are migration debt, not proof that every page already follows this
boundary. No runtime is changed by this document.

Owner clarification, 19 November 2026: Svelte is the selected component approach
for new and migrated pages, including #853. The owner authorizes its dependency
and the focused frontend build setup needed for that migration. This supersedes
the earlier statement that Svelte was only a candidate pending the preview.

## Ownership boundary

- Shared backend services own facts, configuration, English/formal rules content,
  application state, native workflow decisions and other domain results.
- Versioned HTTP APIs expose those results as JSON/data or plain text in the
  existing response/error/coverage conventions. A service's output must be usable
  without rendering a web page. Do not return prebuilt page fragments or HTML
  disguised as API data.
- The browser frontend owns markup, component composition, formatting, selection
  and interaction state. It obtains domain content through the HTTP APIs. Use
  normal frontend component templates or DOM/text rendering, not backend template
  strings or browser `innerHTML` string assembly for migrated/new pages.
- PDB serve serves built frontend assets and a static bootstrap entry. It does not
  inject fetched domain results into server-generated page HTML. Bootstrap labels
  and component markup are normal frontend source; this principle does not claim
  a web interface can exist without HTML.

The browser never queries GitHub directly, reads server configuration files,
evaluates native rules or regenerates their narration. It displays shared backend
results rather than a second implementation of them. CLI and MCP continue calling
shared backend services directly; they are not required to loop through HTTP.
This preserves the configuration/application-state split in
[serve-configuration-layers.md](serve-configuration-layers.md).

The browser calls APIs on the existing PDB serve origin/HTTP port. Internal Node
callers use the canonical domain-service interface directly; an HTTP endpoint is
a thin adapter over that service, not the only way to invoke it. No additional
backend process, listening port or external network service is required. The
Svelte website exercises the API's domain capabilities rather than relying on a
second hidden data path or duplicating decisions in the frontend.

## First migration: Rules

The existing `src/rules/datalog/rules-command.ts` supplies the shared rules document
and text. Current `src/serve/rules-page.ts` reads that content and generates the
page on the server. Reuse that backend source and its effective project-rule
resolution, not a browser copy or a new formal-rule interpreter.

Expose a dedicated read-only rules route (proposed `/api/v1/rules`; check for an
existing suitable route before implementation). A string, list of strings or the
existing typed rules document is sufficient. Reuse existing IDs, English and
formal content, role/project context and policy/narration metadata where supplied;
do not invent a richer AST merely for this migration. The backend supplies the
meaning. The frontend controls presentation, including English-first display and
expandable formal detail, without changing the shared content or rule ordering.

The Rules page becomes a frontend asset/component consuming that route. Its
loading, empty, partial, cancelled and error states use API results; failed reads
never silently display another project's rules or treat missing data as approval.
Escape untrusted text through frontend rendering. Query/role changes and late
responses follow the existing shared project-context/cancellation model. Display
source/coverage/narration metadata where already part of the Rules contract.

Keep the CLI and MCP Rules output consistent with the API by reusing the service,
not by comparing separately generated prose after the fact. `rulesSections` or an
equivalent display helper may arrange supplied text, but cannot decide policy,
invent English explanations or alter supplied formal semantics.

## Incremental adoption

#853 is a focused endpoint-plus-page migration. It does not authorize rewriting
all existing pages at once. New Configuration, metrics and control-page work must
use this boundary; their backend services and APIs stay separate from frontend
rendering. Their existing business acceptance and native prerequisites remain.

The [Svelte Work preview](svelte-work-spike.md) remains a read-only secondary
comparison page using the same data/native ranking as Work. Svelte is now selected
for subsequent new/migrated pages; this does not promote the preview to replace
Work, require a wholesale rewrite, or make CLI/service consumers depend on browser
tooling. Reuse compatible preview/build research when implementing the focused
frontend build. Follow existing TypeScript and packed-asset boundaries.

Preserve shared shell layout/navigation behavior, account/project distinctions,
existing endpoint compatibility, freshness, useful omission notices, bounded lazy
reads, caching and error envelopes. Do not add a second collector, browser polling
loop or store that reconstructs GitHub/workflow state. Existing server controls
remain; new security infrastructure is outside this architecture amendment.

## Focused acceptance

- A backend Rules API response is independently usable and contains no generated
  page HTML. Tests inject the shared rules/config services rather than GitHub.
- The frontend shows the exact supplied content, with safe text rendering and
  useful loading/error/empty states; project/role changes reject stale results.
- Existing CLI/MCP narration, native decisions and effective project rules remain
  unchanged. A focused content-parity case suffices; do not rerun the whole native
  scenario matrix for every UI component.
- Keyboard/narrow layouts preserve the English-first/formal-detail interaction.
  One packed install proves the frontend entry/assets work outside the checkout.
  Server modules do not read a source tree or compile components at runtime.
- Record additional page migrations as small feature tickets, not an unbounded
  HTML search-and-replace or a parallel application architecture.
