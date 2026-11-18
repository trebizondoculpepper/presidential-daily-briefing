# Application Git/GH module migration map

Owner-approved module-sized delivery under #875, following the accepted GH audit
(#868/#871), Git inventory (#872/#895) and controller/facade contract (#898).
This is a work map, not a claim that migrations are implemented. The inventory
was reconciled against application source and includes direct execution, raw
transport/argument consumers and runtime injection/wiring. New private service
implementation modules are the permitted boundary, not new consumer tickets.

## Foundations and order

- #869: typed GH foundation (active implementation #896); `ghauth.ts` is already
  owned by that foundation rather than a duplicate migration.
- #897: typed Git foundation over the installed executable and existing injected
  runner; no new Git library.
- #870: application composition and `src/serve.ts` wiring, including runtime
  declarations in `src/serve/types.ts`. It creates one shared facade of each kind
  per application lifetime, preserving the original lifecycle acceptance.
- CLI/MCP entrypoint migrations additionally wait for the shared composition
  boundary; ordinary feature modules depend only on the foundations they use.

Each table row is one bounded module ticket. A row using both tools has one
combined ticket, avoiding overlapping module edits. Existing module-specific
#887/#889/#891 and composition #870 were reused, not duplicated. All rows have
human ownership and estimates; native prerequisites are authoritative. A closed
prerequisite is not proof of module acceptance. Inspect current code before
editing, and record a verified no-op when foundation work already moved a site.

## Module tickets

| Application module                    | Facades  | Ticket | Complexity | Foundations / wiring |
| ------------------------------------- | -------- | ------ | ---------- | -------------------- |
| `src/briefing/closedquestions.ts`     | GH       | #899   | M          | #869                 |
| `src/briefing/onboardcli.ts`          | Git      | #900   | S          | #897                 |
| `src/briefing/process.ts`             | Git      | #901   | M          | #897                 |
| `src/briefing/service.ts`             | GH       | #902   | M          | #869                 |
| `src/cli.ts`                          | Git + GH | #903   | M          | #897, #869, #870     |
| `src/config/config.ts`                | Git      | #904   | M          | #897                 |
| `src/config/configcli.ts`             | Git      | #905   | M          | #897                 |
| `src/config/contributors.ts`          | Git      | #906   | M          | #897                 |
| `src/config/effectiveidentity.ts`     | Git      | #907   | M          | #897                 |
| `src/config/engine-setting.ts`        | Git      | #908   | S          | #897                 |
| `src/config/humancontext.ts`          | GH       | #909   | S          | #869                 |
| `src/config/identity.ts`              | Git      | #910   | M          | #897                 |
| `src/config/localdoctor.ts`           | Git + GH | #891   | M          | #897, #869           |
| `src/config/project-rules-setting.ts` | Git      | #912   | S          | #897                 |
| `src/config/readidentity.ts`          | Git      | #913   | S          | #897                 |
| `src/config/review-setting.ts`        | Git      | #914   | S          | #897                 |
| `src/estimation/complexitylabels.ts`  | Git      | #915   | M          | #897                 |
| `src/estimation/estimate.ts`          | Git + GH | #916   | M          | #897, #869           |
| `src/estimation/estimation.ts`        | GH       | #917   | M          | #869                 |
| `src/github/commentwrite.ts`          | GH       | #918   | M          | #869                 |
| `src/github/dependencies.ts`          | GH       | #919   | M          | #869                 |
| `src/github/github.ts`                | GH       | #920   | M          | #869                 |
| `src/github/labels.ts`                | GH       | #921   | S          | #869                 |
| `src/github/migration.ts`             | GH       | #922   | M          | #869                 |
| `src/github/quotas.ts`                | GH       | #923   | S          | #869                 |
| `src/github/quotascli.ts`             | GH       | #924   | M          | #869                 |
| `src/github/readplan.ts`              | GH       | #925   | M          | #869                 |
| `src/github/requiredchecks.ts`        | GH       | #926   | M          | #869                 |
| `src/github/shortlist.ts`             | GH       | #927   | M          | #869                 |
| `src/install/manifest.ts`             | Git      | #928   | S          | #897                 |
| `src/mcp.ts`                          | Git + GH | #929   | S          | #897, #869, #870     |
| `src/mcp/server.ts`                   | Git + GH | #930   | M          | #897, #869           |
| `src/metrics/read.ts`                 | GH       | #931   | M          | #869                 |
| `src/rebrief/cli.ts`                  | Git + GH | #932   | M          | #897, #869           |
| `src/rebrief/transports.ts`           | Git      | #933   | S          | #897                 |
| `src/serve.ts`                        | Git + GH | #870   | M          | #897, #869           |
| `src/serve/api.ts`                    | Git + GH | #934   | M          | #897, #869           |
| `src/serve/diagnostic-runs.ts`        | GH       | #935   | M          | #869                 |
| `src/serve/issue-facts.ts`            | GH       | #936   | M          | #869                 |
| `src/serve/registration.ts`           | Git      | #937   | M          | #897                 |
| `src/serve/rules-page.ts`             | Git      | #938   | S          | #897                 |
| `src/serve/services.ts`               | GH       | #939   | M          | #869                 |
| `src/updates/checkout.ts`             | Git      | #940   | M          | #897                 |
| `src/workflow/claimactivity.ts`       | GH       | #941   | M          | #869                 |
| `src/workflow/claims.ts`              | GH       | #942   | M          | #869                 |
| `src/workflow/completion.ts`          | GH       | #889   | M          | #869                 |
| `src/workflow/deliverables.ts`        | GH       | #943   | M          | #869                 |
| `src/workflow/deliverydoctor.ts`      | GH       | #944   | M          | #869                 |
| `src/workflow/deliveryread.ts`        | GH       | #945   | M          | #869                 |
| `src/workflow/issuecreate.ts`         | GH       | #887   | M          | #869                 |
| `src/workflow/prstatus.ts`            | GH       | #946   | M          | #869                 |
| `src/workflow/readservices.ts`        | GH       | #947   | M          | #869                 |
| `src/workflow/retained.ts`            | GH       | #948   | M          | #869                 |
| `src/workflow/retainedfacts.ts`       | GH       | #949   | M          | #869                 |
| `src/workflow/reviewhistory.ts`       | GH       | #950   | M          | #869                 |
| `src/workflow/ticketstatus.ts`        | GH       | #951   | M          | #869                 |

## Earlier capability groups

#878 (account/repository), #879 (issue reads), #880 (PR/review reads), #881/#882
(dependencies), #884 (comments), #886 (labels) and #890 (commit containment) are
coordination/acceptance umbrellas. They retain the audited capability requirements
and link exact module children; they are not competing implementation pickups.
A shared module can satisfy more than one capability group. Do not create a
second PR editing it merely because two groups mention it.

A migration may add the missing typed capability implementation needed by its
module inside the shared service, reusing existing methods. It must not expose
raw argv, arbitrary API paths/queries or opaque JSON as its final consumer API.
Preserve versioned results, native decisions, context/coverage, cancellation,
cache freshness/invalidation and guarded write/recovery behavior. Retain
compatibility adapters while other modules move; remove them only after the last
consumer is accounted for. The final boundary audit/guard under #875 reruns the
inventory and checks that ordinary bypasses cannot be reintroduced.

## Explicit exclusions and already-owned work

- `scripts/`: Standalone tooling and release scripts explicitly excluded by owner; existing safeguards retained.
- `src/github/evidence.ts`: Pure internal response framing/telemetry model; consumed inside GH transport, not an application command caller.
- `src/github/ghauth.ts`: Already included in foundation #869 / PR #896; verify rather than duplicate its active implementation.
- `src/serve/runs.ts`: Typed diagnostic job scheduling; gh is only a section identifier, no direct utility use.
- `src/serve/types.ts`: Runtime type declarations migrate with serve composition #870; no utility execution.
- `src/testing/identity.ts`: Disposable test fixture only, explicitly outside production migration.
- `src/workflow/doctorplans.ts`: Display-only user-run command plans; no executable utility boundary. Preserve honest suggestions.

The source search also distinguishes browser/API presentation from subprocess
use: the word GitHub or a displayed `gh` command is not by itself a migration
site. Release and standalone tooling retain their existing direct-Git exception;
a helper used as part of PDB is not exempt merely because of its directory.
Do not install a new library, change release safeguards, add credentials, or
move workflow policy out of native rules in any module migration.

## Completion and verification

The final boundary ticket is gated on every mapped application module plus the
two foundations. It verifies the actual call/import graph, removes obsolete
public raw boundaries only when unused, and adds a fast architecture check with
focused passing/failing fixtures. Tests and private adapters are explicitly
allowlisted; unrelated node subprocesses and standalone tooling stay usable.
No runtime interception or repeated native-rule matrix is needed for this guard.
