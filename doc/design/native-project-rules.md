# Native project-rule extension v1

Contract for #513–#516, completing the remaining #75 priority/reason customization
boundary after research #499/#512. The executable language is native DataScript EDN,
not TOML priority settings or a trusted whole-policy bundle. No project rule is
enabled by this documentation. Broader new-action/workflow replacement is not v1.

## Source and exact schema

A committed project-root `pdb.rules.edn` contains exactly one EDN map with these
required keys, no unknown/duplicate keys:

- `:format-version` integer 1.
- `:projection-version` integer 1.
- `:base-policy-version` the exact shipped policy version.
- `:base-rules-hash` the exact lower-case 64-hex shipped semantic hash.
- `:rules` a native rules vector. Helpers are named `project-` followed by lower-case
  letters/digits/hyphens; no shipped predicate is imported or redefined.
- `:preferences` a vector of at most 50 records, with unique source-order-preserved
  IDs. Each record has exactly `:id`, `:when`, `:priority`, `:why`, `:witnesses`.

A preference ID matches `project-[a-z0-9][a-z0-9-]{0,62}`. `:when` and `:priority`
are vectors of native clauses. The reserved action variable is `?a`; the priority
clauses must bind `?value` to exactly one integer in 0..1000 for each matched action.
`:why` is nonempty bounded text (at most 512 Unicode code points), with only named
witness placeholders. `:witnesses` is a string-keyed map of at most ten bindings,
each a native clause vector binding `?value`; witness values are scalars, sorted/
deduplicated and bounded in the shared manner. Missing/conflicting priority or
witness bindings are errors, not guessed defaults. Literal `:why` cannot introduce
additional authority; render it as the reason this preference matched.

The committed example is `doc/reports/fixtures/project-rules-v1.edn`. It pins a
historical default hash as a schema fixture; `pdb rules init` generates a starter
with the current hash rather than telling users to copy a stale example. Syntax:

```clojure
:rules [[(project-hotfix ?a) [?a "pdb.action-label" "project:priority"]]]
:when [(project-hotfix ?a)]
:priority [[(+ 0 10) ?value]]
```

Generate a single match query per preference from a mandatory admitted-action fact,
its `:when` and `:priority` clauses. Evaluate witnesses with that action bound; never
allow a free action ID or use a project-provided root query/`:find`/`:in` template.
Project clauses cannot change input schema, lexicon, constants, query templates,
comparison engine or shipped decision definitions.

## Validation and native subset

Reuse the maintained EDN reader/printer and structural English compiler. Reject
nil, tagged literals, reader evaluation, characters, unsafe/non-integer numbers,
multiple forms and unsupported constructs; never silently discard them. Allow
fact patterns, calls to declared project helpers, and/or/not/or-join/not-join,
comparisons `=`, `!=`, `<`, `>`, `<=`, `>=`, and bounded scalar bindings using
`+`, `-`, `*`, `/`, `str`. Reuse the current compiler's operand-arity validation;
results must satisfy the integer priority/scalar witness contract. No aggregates,
host functions, rule imports, recursion or cyclic helper graph. Duplicate helper
alternatives are allowed as native disjunction, but arity must agree.

Hard v1 parser limits: 64 KiB UTF-8 source, nesting depth 20, 10,000 parsed nodes,
100 helper alternatives, 1,000 clauses overall, arity at most 8. Check byte/depth
limits before the recursive parse; count clauses across helpers, preference bodies
and witnesses. Reject unknown calls, ungrounded output variables and reserved IDs.
Validate against the projection lexicon and compile every construct to English;
variable attributes stay explicit. Do not merge projection attribute phrases into
the default policy's lexicon and accidentally redefine its meaning.

## Immutable input projection and admission

Evaluate the shipped default policy first, retaining its complete ordered action
identities and safety results. Project policy sees only adjustable admitted actions,
not raw unadmitted issues or policy entities. This is a separate DataScript database.
Entity 1 has `role` and `order`; action entities begin at 100 with per-evaluation
opaque IDs. Attribute vocabulary is closed and read-only:

| Attribute                                  | Meaning/type                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `pdb.action-id`                            | Exact stable repository + subject + action-kind + role identity (string) |
| `pdb.action-kind`, `pdb.action-role`       | Registered action kind and responsible role (strings)                    |
| `pdb.action-target`                        | Subject URL as an opaque string                                          |
| `pdb.action-label`                         | Collected label values, cardinality many                                 |
| `pdb.base-band`                            | Immutable integer default band                                           |
| `pdb.impact-state`, `pdb.complexity-state` | Existing assessment state strings                                        |
| `pdb.impact-size`, `pdb.complexity-size`   | Size string only when current, otherwise absent                          |
| `pdb.unlocks`                              | Proven lower-bound integer; absence never means zero                     |
| `pdb.unlocks-complete`                     | Boolean coverage of that lower bound                                     |
| `pdb.head`                                 | Current PR head string when known                                        |

This lexicon describes actions, unlike the default policy's subject-kind facts.
Do not expose credentials, arbitrary body/comment text, local paths or synthetic
permission/completion facts. Input absence preserves unknownness; it cannot create
an action. At most 500 projected actions and 50,000 datoms; excess is an explicit
project-scope error, never silent truncation. Label completeness is inherited from
the default admission, not reasserted by the project. No raw database writes from
project output and no default-engine test-policy injection.

Protect default addressed-attention and concrete PR-follow-up bands (currently
bands 1 and 2) by excluding them from the adjustable database. Their original
position/order/reasons remain intact. Project rules cannot erase any admitted
obligation or change its role, target, kind, eligibility, band or next command.
Validate returned IDs against the exact adjustable identities for the current
generation; an unknown/forged ID/kind is an error. Never filter only by subject ID.

Within each other default band under `order=impact`, sort by descending matched
project priority, then the existing default comparison keys. No match gives key 0
and the unchanged default explanation. When multiple preference IDs match, use the
highest key; equal keys retain source-order reason bindings (bounded with omissions),
not a numeric sum. Contradictory multiple keys for one preference/action are errors.
Preserve all matches as auditable provenance. Project reasons supplement required
default why/waiting/unknown warnings; they cannot overwrite them.

Explicit `oldest`/`newest` preserves the default order exactly. Project preferences
are not applied in those modes and the effective metadata says so; do not let a
project defeat an explicit age-order request. Default admission still governs
unknowns, platform gates, ownership and PR state under every order. Command
permission/completion checks always use fresh immutable services independently.

## Isolated execution and failure

Run project evaluation only in a worker, not the long-lived server's event loop.
The parent validates input sizes and enforces a 500 ms query-evaluation deadline
plus a separately bounded 5 s worker startup deadline. Use a 128 MiB JS heap limit,
5,000 returned preference/witness tuples and 256 KiB serialized worker output cap.
These are protective v1 limits, not measured portable capacity or a hard total-RSS
claim. #515 must measure representative allowed fixtures on supported CI platforms
and prove timeout/termination keeps the parent responsive; if fixtures do not fit,
report the limitation and obtain a reviewed limit change rather than silently raise it.

Worker messages contain only bounded projected data and canonical validated policy;
no arbitrary imports, fs/network APIs, child processes or model calls. Use a fixed
packaged worker entry. Cancel/terminate on deadline, disconnected caller, resource
excess or stale effective generation. Result messages must carry the generation
and policy hashes and pass schema/admission validation before use. Concurrent
requests may share a matching evaluation, never another project's state.

An enabled but unreadable/invalid/incompatible/timed-out policy yields an explicit
policy error/incomplete briefing and repair/disable guidance. Do not claim to honor
it while silently reverting to defaults or a cached previous generation. Existing
unmodified defaults work when the setting is disabled/no policy is enabled. An
explicit rollback choice is visible, not an automatic write or permission bypass.

## Configuration, identity, English and packaging

Register project `rules.project.enabled` boolean default false. `pdb rules init`
creates a reviewable starter only in the selected verified checkout, refuses to
overwrite an existing file and prints the explicit config-enable command. Use the
normal config command; never ask agents to edit private config manually. Presence
of a downloaded file does not activate it. Root/path resolution must not escape
the selected checkout via symlinks or remote includes. HTTP selection uses a
verified registered local project; a remote repo name alone cannot name a path.

The extension records its exact base hash. A changed shipped semantic policy
requires a deliberate review/update of the project file; show expected/observed
hash and safe init/diff/disable guidance. No auto-upgrade, history rewrite or new
identity. Layout-only project edits canonicalize identically through the EDN printer.

Keep the default `rulesHash` unchanged when disabled. When enabled and valid,
`rulesHash` reports the composite effective hash, with additive `effectivePolicy`
metadata: state, applied-order mode, format/projection/base-policy versions,
defaultRulesHash, projectRulesHash, effectiveRulesHash, matched project IDs and safe
source identity. Composite hash is SHA-256 over a versioned canonical JSON array
`[1, defaultRulesHash, 1, canonicalProjectForm]`; projectRulesHash hashes the canonical
project form's UTF-8. The manifest versions and base hash are inside that form.
Canonicalize maps by sorted printed key after rejecting duplicates, then use the
shared EDN printer; preserve vector order (including preference order). This extra
map-order normalization is required in the loader, not claimed from printEdn alone.
No local path, timestamp or request ID enters these hashes.

The additive manifest has `schemaVersion:1`, `state:disabled|active|error`,
`formatVersion`, `projectionVersion`, `basePolicyVersion`, `defaultRulesHash`,
`projectRulesHash` (null when disabled/unreadable), `effectiveRulesHash` (null on
error), and `appliedOrderMode:impact|disabled-by-age-order|disabled|error`. Its
`source` is the safe project-relative filename, never an absolute local path.
An active policy under explicit age order still has an effective hash and listing,
but no project ranking/reason effect; the applied mode explains that distinction.
Each affected row adds matched project IDs to `why.ruleIds` and a bounded
`why.project` array of `{id, priority, text, facts}`; keep default rule IDs/text and
safety warnings and identify omitted project witnesses/reasons. Full English rule
selectors accept the registered project-prefixed IDs as well as default IDs.
Do not misuse `overriddenRuleIds` to claim a default safety rule was overridden.

Compile default and project models separately using the shared structural compiler
and their correct lexicons, then render one effective English document. Include
project conditions, priority/witness bindings, protected sections, limits, explicit
age-mode behavior and source IDs. A default-only listing is not effective policy.
CLI `pdb rules`, web rules, MCP/diagnostics, per-row why and native rule-only examples
must identify the same effective revision. Existing `process` remains short workflow
navigation to `rules`, not a second handwritten policy source. Package the parser,
validator and fixed worker so installed operation needs no source checkout or
accidental devDependency. Use native EDN scenario definitions and shared JUnit
reporting to distinguish decision assertions from loader/worker failures.

## Delivery and acceptance

#514 supplies source/format/static validation and canonical identities; no activation.
#515 supplies the worker, immutable admission and native preference/reason evaluation.
#516 supplies program-mediated enablement, generation/caches, effective English and
installed CLI/MCP/web parity. All three depend on this reviewed contract and their
native predecessors. #75 remains open until its full default/override/output/test
requirements are verified; a schema or worker alone does not complete it.

Required fixtures include valid native conditional/key/reason, multiple matches,
no-match/default parity, old/new age-order parity, protected-band invariance,
forged subject/kind/role, old generation, other owner, missing evidence, unsupported
calls/attrs, reserved/shadowed names, duplicate keys/IDs, cyclic helpers, exact and
mismatched versions/hash, source/depth/datoms/output excess, explosive joins,
worker startup/evaluation timeout, cancellation, wrong root and symlink escape,
layout versus semantic changes, error/no silent fallback, and complete effective
English/source/hash parity across packaged surfaces. No live project activation or
model trial is required by these tests.
