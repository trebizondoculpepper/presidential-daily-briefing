# One-off owner-requested release, 19 November 2026

The owner explicitly requests an official release starting at 05:00 Europe/London
on 19 November 2026 (05:00 UTC on that date), containing merged work available
then. This replaces the earlier request to publish immediately after the audit.
Do not wait for logging, onboarding or other unimplemented features; never include
unmerged PRs or bypass normal verification/publication checks.

## Durable one-off controller

Use a dated GitHub Actions schedule on the default branch, not a sleeping local
agent/process. Cron is UTC and can run late; do not promise publication at an exact
minute. The existing Publish workflow still receives only workflow_dispatch and
performs verification, package install/smoke, version selection, trusted npm
publication and matching GitHub release. Scheduled code only makes the explicit
owner-authorized request through the canonical npm run release helper. No schedule
or push trigger is added to publish.yml itself, and no recurring release policy
is introduced.

The controller is restricted to the canonical repository and the UTC date
2026-11-19. A delayed run on that date selects the last origin/main commit with
committer timestamp at/before 2026-11-19T05:00:00Z, using full history; this is the
normal GitHub merge-timestamp cutoff, not a fabricated snapshot of an unobservable
server reflog. It prints the full SHA/cutoff and passes --sha to the helper, so
newer main work is not silently pulled into the release. Do not reset or force-push
release, change NPM_PUBLISH or npm permissions, or disable required checks.

Use concurrency for this dated request without cancelling in-progress publication.
The helper's same-SHA/channel idempotence and immutable registry history remain
authoritative. An unavailable source, failed setup/verification or failed dispatch
is failure, not a release; expose the workflow/run evidence. No blind repeated
publication request after an ambiguous dispatch.

The controller disables its own dated workflow after the dispatch attempt, with
permissions limited to the repository contents/Actions operations needed by the
existing release helper and self-disable. The explicit date check also prevents
a future annual cron match from publishing. Do not offer a generic recurring
release/force UI or an unrestricted manual-dispatch path. A disabled/failed schedule
is inspectable and a retry of the selected SHA is a new explicit maintainer action.

## Validation and follow-up

Validate the date/cutoff selection and one-off guards without triggering publication
now. Run required configuration-change checks and review/CI before merging the
controller. Installation uses Node 26 and existing npm/gh tools; no local token
files or new dependencies. A successful schedule setup is not publication.
Tomorrow's handoff must distinguish scheduled, dispatched, verified, published
and metadata-complete outcomes. Remove the spent disabled controller in a small
follow-up after its result is inspected, rather than leaving an active recurring job.
