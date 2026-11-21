# Explicit human-directed workflow overrides

Owner direction for #1016. Requires the reviewed [logging service](local-logging.md)
(#1017) before runtime delivery. This contract implements nothing by itself.

## CLI and scope

For supported workflow mutations, `--force "reason"` requests explicit human-directed
policy override. It takes the reason as its value; a bare boolean flag is invalid.
Reject a missing value, empty string or whitespace-only string before any mutation.
Check `trim().length > 0` but preserve the original accepted text subject to shared
secret redaction. Bound the reason at 4,096 UTF-8 bytes and reject excess rather
than silently truncate. No LLM or semantic persuasion check evaluates the reason.
A reason is an asserted human instruction, not proof of authenticated identity.

Force is a workflow-policy mechanism, not an alternative utility executor. It is
initially integrated with shared native admission for claim/resume/rework and the
ownership-release operation. Other mutation families become supported only when
their native override decision and real execution/result path are explicitly
covered by the same contract and tests. Unsupported commands reject the option;
reads must not acquire side effects because force was supplied. Do not silently
expose arbitrary shell execution or extend force to release/publication/merge.

## Native decision first

The policy ticket defines the normal decision, exact denied rule IDs/explanations,
explicit human-direction request and supported override plan. Every workflow denial
in the supported operation's declared scope is listed, rather than hiding all but
the first. TypeScript gathers facts and executes the resulting plan; it must not
implement a parallel allowlist of policy exceptions. Never substitute a generic
warning string for the rules that actually matched.

Existing permission/authentication, literal-input validation, current subject
identity, executable/API availability and safe write/retry mechanics still apply.
Force cannot invent missing facts or pretend an action completed. Stale subject or
ownership revisions require a new decision/audit, not execution against another
owner. Missing optional agent context alone is not a reason to invent an identity.
Human-directed precedence is explicit; ordinary autonomous calls retain defaults.

No new signing/login/security framework is introduced. Reuse the existing trusted
local CLI and confirmed served-write provenance where applicable. For this CLI
slice, the flag asserts human direction and the receipt identifies that assertion;
it is not described as cryptographically verified human intent. Environment/client
metadata remains factual context only. New HTTP/MCP force exposure is a separate
explicit transport integration, never arbitrary tool arguments as authority.

## Output and ordered audit

Before dispatch, print the operation, rule IDs and readable explanations, followed
by: "Workflow override requested. Overrides may only be used under explicit human
direction. Inform your human which rules were overridden and what happened."
Send diagnostics to stderr. JSON retains valid machine-readable stdout and includes
structured override metadata. Escape terminal/control characters in displayed
reasons; do not allow the reason to forge console messages or JSON records.

Use the shared logging service to record version, operation/correlation ID, target,
action, original normal decision, overridden rules, reason and available human,
agent/session context. Unknown fields stay explicitly unknown; no identity minting
or borrowed name. No new token store. Successfully await the pre-action audit write
before dispatch. If disabled, failed or timed out, return `AUDIT_UNAVAILABLE` and do
not perform the forced mutation. Ordinary logging follows its separate warn/continue
behavior. A force request with no policy denial records that no rule needed override;
it does not claim one was violated.

After dispatch, record confirmed success, refusal, failure, partial or unknown
outcome with the same operation ID, and tell the caller what actually happened.
If outcome logging fails after a remote write, report that distinction and retain
the action's uncertain/confirmed result. Never retry the action merely to repair
the audit. No atomic transaction is promised between local logs and GitHub.
A pre-action event left without an outcome proves intent only. The agent must
report back to its human; the warning does not send external messages automatically.

## Delivery and acceptance

Deliver native policy/decision-matrix #1021 first, after ownership policy #1018,
with minimal fact adapters;
then #1022 integrates TypeScript parsing, logging and commands after #1021,
logging #1017 and ownership integration #1019. Add small tickets
for unsupported command families rather than declaring a universal bypass shipped.
Initial matrix: allowed normal action; denied action without force; explicit force
with actual rule explanations; empty/whitespace/oversized reason; unknown agent;
audit unavailable; stale revision; missing credentials; failed/uncertain remote
write; post-action audit failure; no semantic reason evaluation; valid JSON output.

#1014/#1018/#1019 ownership release is independently human-directed and does not
wait for generic force or logging. Force is optional recovery tooling, not required
to express every ordinary human ownership decision.

## Native decision matrix (#1021)

The native policy now decides a force request. The host asserts facts on the subject, and no TypeScript allowlist exists: `force-request true`, `force-operation` (claim, resume, rework or another name), `force-reason` (`valid`, `empty` or `oversized`, checked by the host before any mutation, never graded semantically), `force-agent` (`known`/`unknown`) and `force-revision` (`current`/`stale`). Ordinary claim admission (`claim-deny`) still lists every denial. Exactly one decision results:

| Decision                     | When                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D-FORCE-REFUSE-UNSUPPORTED` | The operation has no native override path yet (anything but claim, resume, rework)                                                                                                                                                                                                                                              |
| `D-FORCE-REFUSE-REASON`      | The reason is empty, whitespace-only or over 4,096 bytes                                                                                                                                                                                                                                                                        |
| `D-FORCE-REFUSE-AGENT`       | The acting agent is unknown; no identity is invented                                                                                                                                                                                                                                                                            |
| `D-FORCE-REFUSE-STALE`       | The subject or ownership revision changed; a new decision is needed                                                                                                                                                                                                                                                             |
| `D-FORCE-REFUSE-TECHNICAL`   | Any denial is technical or authority evidence (`D-DENY-CLAIM`, `FORCE-NOT-RETAINED` (resume or rework without the caller's own retained claim), `D-DENY-LABELS-UNKNOWN`, `D-DENY-NATIVE-UNKNOWN`, `D-DENY-CLOSING-UNKNOWN`, `D-DENY-INVENTORY-UNKNOWN`, `D-DENY-REFINEMENT-UNKNOWN`, `CLAIM-INVENTORY-UNKNOWN`); all are listed |
| `D-FORCE-NO-DENIAL`          | Nothing denied the operation; nothing is overridden                                                                                                                                                                                                                                                                             |
| `D-FORCE-OVERRIDE`           | Only workflow-policy denials apply; every overridden rule ID is listed, with the required warning                                                                                                                                                                                                                               |

Each listed rule's readable explanation is the existing denial text. Ownership release keeps its own human-directed path (#1018, `D-UNASSIGN-*`); force for release is a separate slice. Scenarios: `src/rules/datalog/scenarios/force-overrides.edn`. CLI parsing, audit logging and execution are #1022.
