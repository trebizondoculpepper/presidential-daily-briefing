# Dashboard edits: complexity, impact and urgency

Contract for #455, after the read-only shell/ticket detail (#374/#454). This is a
planned later slice. It does not enable writes in the current read-only server or
change the separately read-only diagnostic REST API. Reuse existing assessment
services, urgency labels and cache; do not add another priority model.

## Deliberate activation and authority

Editing is disabled by default. Register a global boolean `serve.allowEdits` and
an explicit startup `--allow-edits` override; the startup banner and safe capability
metadata state whether editing is available. Only the initial listener startup
may enable it; another `pdb serve` invocation registering a project cannot silently
enable writes in a running read-only instance. A configuration change takes effect
on explicit restart, matching other listener-mode changes.

Keep localhost binding and existing Host/Origin checks. Write requests require the
actual same-origin browser Origin, JSON content type and a separate UI anti-CSRF
session. Do not reuse or reveal the private instance-registration control token.
Use Node's standard crypto and a small in-memory session: a same-origin UI bootstrap
returns a CSRF token and sets an HttpOnly, SameSite=Strict, Path=/ session cookie,
with Secure when HTTPS is actually used. Do not set Domain or allow cross-origin
credentials/CORS. Validate cookie and matching `X-PDB-CSRF` token before a write;
reject missing/foreign Origin, form bodies, mismatched/expired tokens and unknown
fields before any GitHub operation. Expire idle sessions in 30 minutes; restart
clears them. No durable session database, JWT or new account/login service.

This prevents an unrelated website driving a local user's browser into writes; it
does not authenticate a human against other processes on the same trusted machine.
The existing host `gh` credential supplies GitHub authority. Freshly verify its
effective write/maintain/admin repository permission before applying an edit;
unknown/denied permission refuses. A reported human/agent name is provenance only,
never permission. No new token is requested, stored in project files or sent to the
browser. The UI asks for an explicit actor name for the assessment record; do not
borrow a detected agent identity or claim that a shared login names the operator.

## Small edit interface

The ticket detail shows the currently observed value/provenance and one explicit
Edit control per field. The dialog requires the new value and rationale, previews
the selected project/ticket/old/new values and lets the user Save or Cancel. No
write on opening, selecting a value, changing project or loading a queue. Save is
one field at a time; no bulk edit, inline automatic save or "claim and implement".

Use `POST /api/v1/tickets/{n}/edit?repo=R` with a strict typed body:

```json
{
  "operationId": "client-generated-request-id",
  "actor": "explicit-operator-name",
  "field": "impact",
  "value": "L",
  "rationale": "Meaningful outcome for the selected project",
  "expectedRevision": "revision-returned-by-the-ticket-detail"
}
```

`field` is exactly `complexity`, `impact` or `urgency`. Metric values use the
existing XS–XXL validator; urgency is `high`, `normal` or `low`, reusing
`urgency:high`/`urgency:low`, with normal meaning neither label. No arbitrary label,
property, issue body, command or GitHub endpoint is accepted. Bound all strings
with the shared input validators and body-size limits. No shell interpolation.

The expected revision covers the ticket identity/state and the relevant current
labels/assessment provenance, not arbitrary unrelated discussion text. Construct it
in the shared read/mutation service and return it with #454's detail data. Re-read
that evidence live before the write; reject stale revision with 409 and refreshed
field evidence, never overwrite silently. Contradictory labels/unknown provenance
produce the existing diagnosis and supported recovery, not a guessed old value.
The first UI slice edits open issues only; closed sources stay read-only with CLI
guidance. No implicit reopen or workflow readiness/status-label change.

Complexity and impact call the same mutation/permission/rationale/provenance
services as `pdb estimate`, including replacement guards. Roles remain guidance:
implementers normally estimate complexity, designers impact; an authorized human
can deliberately edit either. The UI must not require an implementation claim for
an estimate or change the estimate's recorded meaning. Disabled metric settings
remain visible and the existing service's refusal is honored.

The current CLI does not expose an urgency mutation command. Reuse its registered
label vocabulary and introduce a small shared urgency mutation service if needed,
rather than implementing raw label writes in the browser. It validates the previous
urgency, changes only the two registered urgency labels, and records a bounded
audit comment with actor, rationale, old/new values and operation ID. Permission,
read-back and partial-write handling follow the same mutation boundary. This is
not permission to reinterpret urgency as estimated impact or store UI-only flags.

## Outcome, retry and cache behavior

Return a versioned typed mutation result with operation ID, applied/refused/partial/
unknown state, fresh field evidence and relevant source links. An HTTP 200 alone
does not mean all remote steps succeeded. Disable duplicate Save while in flight;
if the connection fails after sending, show an uncertain outcome and inspect before
retry. Never optimistically display a confirmed saved value before read-back.

Bind operation ID to normalized repository/ticket/actor/field/old revision/new value/
rationale. An ID reused with different intent returns conflict. Reuse the existing
mutation's durable intent/provenance semantics where available. A small in-memory
in-flight/completed request map coalesces duplicate HTTP delivery; it does not promise
exactly-once writes across restart. After restart/unknown outcome, inspect current
labels and recorded operation/provenance before offering an explicit retry. Never
automatically repeat a possibly applied edit or delete an audit comment to hide it.

Successful and uncertain writes invalidate affected cached issue/queue/dependency
views, using #453's generation guard so earlier in-flight reads cannot repopulate
old values as current. A confirmed field update is not a claim that a newly fetched
queue has already been reranked; show its refresh state and use the shared rules.
An unrelated CLI/external write still uses TTL/manual refresh until a real
cross-process notification path exists. Do not add polling or a second data model.

## Acceptance

Injected mutation/clock/permission/browser tests cover disabled-by-default capability,
explicit startup activation, no enablement by second registration, origin/Host/
cookie/CSRF/body validation before GitHub access, no secret output, denied/unknown
permission, explicit provenance identity and cancelled dialogs with zero writes.
Verify all three fields, enum/rationale/disabled-metric errors, stale revisions,
multiple labels, closed issue refusal, existing estimate replacement/provenance
parity, normal urgency removing only its two labels, and no workflow/claim changes.

Exercise duplicate intent, changed intent, timeout before/after commit, partial
label/comment updates, read-back failure, restart and explicit retry. Test cache
invalidation against an earlier in-flight fetch and project/actor isolation.
Health, diagnostic REST, old read API and MCP remain read-only/compatible; no write
tool is added to MCP in this ticket. A packaged/browser smoke validates the actual
local Save path without live GitHub writes. Review this contract before code.
