# Compile the executable rules to English

Implementation contract for #416 and shared rendering for #392. Owner compilation
decisions are recorded on #416; the later onboarding direction is recorded on #391.
This document does not implement the command. Its first delivery must not depend
on a running web server, MCP configuration or AGENTS.md editing.

## Purpose and source of truth

`pdb rules` prints the complete represented policy in English to stdout. This is
mechanical compilation of the native DataScript EDN, not a list of runtime `:why`
templates and not a separately authored description for each rule. Runtime why
templates remain unchanged for explaining a matched recommendation.

Use the native parser/build pipeline and the same validated bundle consumed by the
engine. Installed consumers must work from packaged artifacts, outside a checkout,
without native source-file paths, GitHub credentials or network calls. The compiler
is a pure component reusable by CLI, the web rules page and future onboarding.

The output covers decision rules, supporting predicates, eligibility/denials,
unknown-evidence conditions, ranking keys and overrides. Report the boundary to
TypeScript mutation enforcement explicitly; compilation of the formal policy is
not proof that every application guard has already been encoded in Datalog.

## Lexicon and supported forms

Add a small declarative lexicon to `policy/schema.edn` naming input attributes and
viewer facts, including agent, role, platform and requested order. Phrases name
inputs only, never describe an individual rule or restate its logic. For example,
the input `open-blockers` can be named “number of open blockers”. Enumerate the
actual attributes from the policy instead of assuming a fixed count.

The build requires phrases for every literal fact attribute used by the compiled
policy and verifies that viewer attributes are named. Variable attributes remain
explicit variables, not guessed English. Duplicate/conflicting definitions fail.
Do not add per-rule English overrides to get difficult clauses past validation.

Compile native forms structurally, preserving variables and logical grouping:

- Fact patterns describe the entity, attribute, value and wildcard/existence test.
- Predicate calls name the predicate and arguments; the glossary compiles every
  alternative definition, retaining conjunction within each alternative and the
  disjunction between alternatives. Do not recursively expand cycles forever.
- `and`, `or`, `not`, `or-join` and `not-join` retain their grouping and join scope.
  Negation must not turn unknown evidence into a positive permission claim.
- Equality, inequality, ordering comparisons, arithmetic and string bindings render
  their actual operator, operands and result variables. Support the constructs
  actually present in this artifact, including distinct-count aggregation where
  queries use it. An unsupported construct is an error, not omitted text.
- Decision IDs, action kinds, bands/preferences and denial IDs are read from the
  policy. Constants, role tests and label values remain factual source literals.

Readable controlled English with visible predicate/variable names is acceptable;
invented semantics or unbounded prose paraphrasing is not. A successful build must
account for every source construct, not only the predicates currently reachable
from a selected example ticket.

## Ordering is executable data

Move the explicit pairwise exceptions currently embedded in the q0 override query
into declared policy data: a list of winner/loser rule IDs. The engine's override
query and the English rendering must both derive from that list. Preserve the
existing generic same-kind band/preference/identity rules and ordering semantics.
Validate IDs, duplicate/contradictory pairs and unsupported cycles.

Compile the declared sort columns in their actual sequence, including ascending/
descending transforms and explicit age-order exceptions. Do not describe ownership
as an unconditional highest priority if it is only a later tie-break key.
Golden parity must prove that this representation change does not change selected
actions, order, denials, matched facts or runtime why text. Document any intentional
artifact/hash representation change separately from a policy behavior change.

## CLI interface

`pdb rules [--json] [--rule ID] [--role implementer|designer]`

The default is the full bundled policy and its declared defaults. Keep `pdb process`
as the existing short workflow guide and cross-link the two; neither pretends to be
the other. No implicit repository discovery/network query is needed for the default.

Print policy version/hash, declared defaults, decision bands/rules, eligibility and
denials, ordering/overrides, predicate glossary and the non-formalized boundary.
Sections come from the artifact, not a repository-specific exception list. Show the
English condition and resulting action/restriction for each rule, not merely its
name. Include source identities usable by the web renderer without disclosing
absolute build-machine paths.

`--rule` selects a declared rule or predicate; retain its required glossary and
applicable precedence context. Unknown IDs fail with a useful list/detail hint.
`--role` must retain generic/shared conditions and possible cases for that role;
do not silently prove a predicate false without facts. If static pruning is not
provable, preserve the conditional rule rather than omit it. Every filtered output
declares its filter and that it is a subset. Do not call a filtered view “all rules”.

`--json` returns a versioned document containing policy identity, scope/filters,
defaults, compiled rule/predicate sections, ordering and coverage. Text and JSON
project the same compiled document. Without explicit project context, effective
repository settings are unknown, not assumed equal to defaults. A later explicit
project-context option may use the shared verified local configuration resolver;
it cannot be implemented by adding a hidden GitHub lookup to this local command.

Do not silently truncate the complete listing with the normal briefing row/character
budget. Diagnostics go to stderr. Exit 0 for a valid complete represented-policy
document (even when its boundary says some application guards are outside Datalog),
2 for invalid arguments, and 1 for parse/build/lexicon/unsupported-form failures.
Compile/validate before printing so failure does not leave a partial listing that
looks complete on stdout. Include a command-specific `--help` path.

## Onboarding and AGENTS.md

The owner subsequently chose a short copyable prompt pointing to onboarding/current
rules. #391 generates actual per-project URLs; #350/#351 own the reusable onboarding
path. Persist a small PDB coordination section in AGENTS.md: links, identity/help
instructions, CLI/MCP use and a requirement to read current rules each session.
Preserve unrelated guidance and update idempotently; do not duplicate a full compiled
rules snapshot by default. The web page itself never silently edits project files.

This resolves the delivery choice without blocking the urgent stdout compiler.
Explicit writing/synchronization tooling, if added by #351, works for this repository
and consumers alike and must detect malformed/duplicate managed sections. No
AGENTS.md write flag or global freshness gate is required in the first `pdb rules`
delivery; the policy artifact itself retains its existing build freshness check.

## Acceptance and rollout

Use small synthetic native fixtures for every supported construct, all actual
production policy forms, repeated predicate alternatives, scoped joins, negation,
denials, role/filter coverage, constants and ordering exceptions. Fail on missing
lexicon entries and unsupported syntax. Change a fixture clause and prove English
changes without an edited rule description; changing `:why` alone must not rewrite
the compiled condition. Compare text/JSON semantics and stable deterministic output.

Run native scenarios and the existing policy parity suite after moving precedence
exceptions into data. Add installed-package checks for no-credential invocation
outside a checkout, complete stdout/piping, stderr-only errors and help/filters.
The standalone compiler ships before #392's page. No inference, mutation-authority
or ranking change is bundled into this feature.
