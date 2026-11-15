# Diagnostics page: interactive read-only Doctor and Ticket Doctor runs

Status: proposed contract for #585, delivered under #589. Nothing here is implemented by this document. Sections headed "Shipped today" describe current behaviour and cite the implementing file; everything else is a proposal.

## Owner decisions (settled)

From #585 and its owner-confirmed split, adopted without reopening:

- One Diagnostics page with two tabs, **Doctor** and **Ticket Doctor**, each with an explicit **Run** control. The tools are not interchangeable.
- **Doctor** diagnoses PDB configuration and missing dependencies on the machine running `pdb serve` (not the browser's machine). It works with no project selected; project checks need a registered project with a verified local root and are otherwise shown as unavailable with the reason.
- **Ticket Doctor** diagnoses ticket problems once the system is operational and requires a selected project.
- First version reports evidence and suggested fixes only. Suggested repairs are displayed, never executed. No auth login, config writes, migrations, claim changes, ticket closure, hook installation, npm update or restart.
- Explicit Run/Refresh with observed (never fabricated) progress, cancellation, last-run and source time, partial/error/cancelled states, bounded results and drill-down. No polling, schedule, automatic run on startup or registration, or all-project fan-out.
- Equivalent concurrent runs are shared by verified host, auth and project context, with independent cancellation per waiter; a selection change never shows another project's late result.
- The passive `GET /api/v1/diagnostics/*` API keeps its behaviour; active runs are a separate, explicit API.

## Shipped today

### Doctor

`localDoctor(options, runtime)` in `src/config/localdoctor.ts` (`LOCAL_DOCTOR_SCHEMA_VERSION = 1`, `MINIMUM_NODE_MAJOR = 26`) never throws for missing evidence. Injected `LocalDoctorRuntime`: `cwd`, `fs`, `probe` (default `nodeProbe`, `execFile` with a 15 s timeout), `nodeVersion`, `env`, `dependencies`. Options: `repo`, `agent`, `role`, `entry`, `harness`. Check IDs: `runtime.node`, `install.dependencies`, `gh.available`, `gh.auth`, `project.checkout`, `identity.file`, `identity.git-ignored`, `identity.git-tracked`, `identity.agent`, `triage.role`, `identity.parse`, `identity.entry`, `identity.name`, `identity.triage-role`. Status is one of `ok`, `missing`, `invalid`, `access`, `unsupported`, `unknown`; only `ok` is healthy. Each `LocalCheck` has `id`, `status`, `source`, `detail`, `next[]`. Probe output is parsed, never echoed; environment values are never reported. There is no `AbortSignal` and no progress callback. CLI: `pdb doctor` in `src/cli.ts`, exit code from `localDoctorExitCode`.

### Ticket Doctor

`pdb ticket-doctor [--repo --json --stale-hours --limit --cache --offline --since ISO]` in `src/cli.ts` collects a snapshot, runs `diagnoseDelivery` (`src/workflow/deliverydoctor.ts`) and, with `--since`, `diagnoseClosedDrift`, then the pure synchronous `ticketDoctor(snapshot, options)` (`src/workflow/ticketdoctor.ts`). Bounds: `limit` default 30 (rest counted in `omittedTickets`), `doctorStaleHours = 24`, `deliveryDoctorTicketCap = 20` live delivery evaluations, `closedDriftIssueCap = 50`. `TicketDoctorReport` (`kind: "ticket-doctor"`, `schemaVersion: 1`) carries `freshness`, `scanned`, `summary { tickets, definite, candidate, unknown }`, `tickets`, `omittedTickets`, `completeness { complete, warnings }`, `guidance` and optional `closedScan`. A `DoctorFinding` has `kind`, `certainty` (`definite`, `candidate`, `unknown`), `detail` and a `CorrectionPlan` of `command`, `inspect` or `manual` steps built in `src/workflow/doctorplans.ts`; plans are never executed. Partial evidence turns absence-based findings into `unknown`. Exit 0 when complete, 2 when incomplete. `DeliveryDoctorRuntime` accepts an optional `signal`, which the CLI does not pass; `ticketDoctor` itself takes none; there is no progress callback.

### Passive diagnostics API and cache

`src/serve/diagnostics.ts` serves `/api/v1/diagnostics/{projects,config,cache,inflight,errors,rules}` per [serve-diagnostics-api.md](serve-diagnostics-api.md): GET only, zero GitHub requests, no refresh, bounded cursors. `ServeCache` in `src/serve/cache.ts` coalesces identical collections with reference-counted abort (`wait`: the last waiter's abort aborts the flight), caps concurrency at `MAX_CONCURRENT_COLLECTIONS = 4`, does not record a cancelled flight as an error and starts a shared cooldown on quota refusal.

### Serve boundaries

`guardRequest` (`src/serve/http.ts`) enforces Host and same-origin Origin; `readJsonBody` requires JSON and caps the body at 64 KiB (`src/serve/options.ts`); served projects come from `selectRepository` (`src/serve/api.ts`). No page today runs Doctor or Ticket Doctor.

## Typed run service

Proposed module `src/serve/runs.ts`, one generic run registry with two registered run kinds. It reuses the existing services; it adds no checks or findings of its own.

```ts
type RunKind = "doctor" | "ticket-doctor";

interface RunRequest {
  kind: RunKind;
  repo: string | null; // required for ticket-doctor; optional for doctor
  options: { staleHours?: number; limit?: number }; // ticket-doctor only, CLI bounds
}

interface RunStatus {
  schemaVersion: 1;
  kind: "diagnostic-run";
  runId: string; // random, per process; identifies the shared execution
  waiterId: string; // random, per POST; this caller's subscription and cancellation handle
  run: RunKind;
  context: { host: string; login: string | null; repository: string | null };
  state: "running" | "completed" | "partial" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  progress: Array<{
    step: string;
    state: "pending" | "running" | "done" | "skipped";
    detail: string | null;
  }>;
  result: LocalDoctorReport | TicketDoctorReport | null;
  error: { code: string; message: string; next: string[] } | null;
}
```

Rules:

1. **Waiters.** Every POST creates a new waiter with its own unguessable `waiterId`, even when it joins an existing execution. Status reads and cancellation take the `waiterId`; a cancelled or unknown `waiterId` cannot affect any other waiter, and repeating a DELETE is a no-op.
2. **Context key** is `(run kind, verified host and gh login from the cache's auth context, repository or none, normalised options)`. A second equivalent request while one runs joins it; each joiner holds its own waiter with independent cancellation, using the same reference-counted pattern as `ServeCache.wait`. The last waiter's cancel aborts the run.
3. **Progress** lists only real steps the service passes through: for Doctor each check group (runtime, dependencies, gh, project, identity) as it completes; for Ticket Doctor `collect`, `delivery` (with `n of ≤20` evaluated), `closed-scan` when requested, `findings`. No percentages.
4. **Cancellation** passes an `AbortSignal` into the snapshot collection and `DeliveryDoctorRuntime.signal`, and into the Doctor probe (an addition: `probe` gains an optional signal that kills the child). A cancelled run is `cancelled`, never `failed`, and is not recorded as a GitHub failure.
5. **Retention.** The last completed result per context key is kept in memory for 30 minutes with its `finishedAt`; the page shows it as "last run at …", never as current. A new Run replaces it. Nothing is persisted.
6. **Bounds.** At most one active run per context key and four in total (sharing the cache's collection limit for Ticket Doctor reads); more returns 429 `RUNS_BUSY` with nothing queued. Ticket Doctor options are validated against the CLI ranges.
7. **Doctor context.** With no project: only `runtime.node`, `install.dependencies`, `gh.available`, `gh.auth`; project and identity checks appear as `skipped` with "select a registered project with a local checkout". With a project: the served project's verified local root becomes `cwd`; a project registered without a local root skips project checks with that reason. The browser never supplies a path, executable or argument.
8. **Ticket Doctor** runs the same code path as the CLI, through the serve read runtime and cache, so counts and findings match `pdb ticket-doctor --json` for the same snapshot. `--offline`, `--cache` and `--since` are not exposed in the first slice.
9. **Redaction.** Results pass through the existing local-path and diagnostic redaction (`redactLocalText` in `src/mcp/redact.ts`); credentials, environment values and raw process output never appear.

## HTTP API

Run routes live under `/api/v1/diagnostic-runs`, outside the passive `/api/v1/diagnostics/` prefix, whose handler answers every non-GET with 405 (`src/serve/diagnostics.ts`).

- `POST /api/v1/diagnostic-runs` with JSON `RunRequest`: starts or joins; returns 202 and a `RunStatus` carrying a new `waiterId`. Same Host/Origin/JSON guards as `/api/v1/refresh`. It changes no state outside the in-memory run registry, so it uses the refresh route's protection level, not the #455 write session; it must not perform any GitHub or local write.
- `GET /api/v1/diagnostic-runs/waiters/{waiterId}`: current status for this waiter. The page re-reads it on a short interval **only while its own run is running** and stops on any terminal state; this is the page following its own explicit request, not background polling.
- `DELETE /api/v1/diagnostic-runs/waiters/{waiterId}`: cancels this waiter only; the execution stops when no waiter remains.
- `GET /api/v1/diagnostic-runs/latest?kind=doctor|ticket-doctor&repo=R` (`repo` optional for Doctor; Ticket Doctor options as query parameters): read-only lookup of the retained result for that context key, or of an execution already running for it. Returns 200 with `{ state: "none" }` when nothing is retained, otherwise a `RunStatus` without a `waiterId` (a running execution is shown as running; watching it still needs a POST to join). It never starts a run.
- Unserved or malformed `repo` gives 403/400 without a read; Ticket Doctor without `repo` gives 400 `PROJECT_REQUIRED`.
- The existing passive views are unchanged; `inflight` may list active runs by kind and context, never results.

## Page

- Route `/diagnostics?repo=R&tab=doctor|ticket-doctor`, using the shared toolbar from [dashboard-pipeline-metrics.md](dashboard-pipeline-metrics.md) (#605). The Doctor tab heads its results "Server machine: checks run where pdb serve runs".
- Nothing runs on load. Each tab calls the `latest` lookup and shows the last retained result for the current context, if any, labelled with its time, and a **Run** button; while running, a **Cancel** button and the observed step list in an `aria-live` region.
- Doctor results: one row per check with status text (not colour alone), detail and the `next` commands as copyable text.
- Ticket Doctor results: summary counts by certainty, then tickets with findings in service order; each finding shows certainty, detail and the plan's steps as copyable commands; tickets and PRs link to `/ticket?repo=R&n=N` and GitHub. Incomplete coverage shows its warnings above the results and the heading never says "healthy" when evidence is incomplete. Omitted tickets are counted.
- Switching project or tab cancels the page's waiter and discards late responses by generation.
- All text escaped; no inline script; dashboard CSP; keyboard and narrow layouts.

## Implementation slices

1. **Signals and progress hooks in the services.** Optional `signal` for the Doctor probe and the Ticket Doctor path; optional `onStep` callback emitting the real steps. Checks: CLI output unchanged; cancellation kills a probe child; aborted collection yields `cancelled`; no new findings.
2. **Run registry and API.** Checks: join and independent cancel by `waiterId`; a repeated or foreign DELETE affects no other waiter; last waiter aborts; `latest` returns `none`, retained and running states without starting a run; `RUNS_BUSY`; retention and expiry with injected clock; context isolation across projects and gh logins; cancelled not counted as error; no write of any kind (assert injected fs and GitHub write boundaries untouched); parity of Ticket Doctor JSON with the CLI for the same injected snapshot.
3. **Doctor tab.** Checks: no-project subset with skipped reasons; project without local root; redaction of paths and environment; packaged install.
4. **Ticket Doctor tab.** Checks: complete, incomplete, empty, failed, cancelled and rate-limited runs; finding links and counts match the CLI; late-result isolation on project change; accessibility.

Slices 1–2 can start once this document merges; 3–4 also need #605's shell for navigation but can ship with the current header if #605 lags.
