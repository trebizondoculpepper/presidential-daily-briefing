# Settings page: registered scopes, explicit save and safe local writes

Status: proposed contract for #584, delivered under #589. Nothing here is implemented by this document. Sections headed "Shipped today" describe current behaviour and cite the implementing file; everything else is a proposal. Implementation is blocked natively by #452 (global configuration and project registration) and must not claim a scope is editable before its underlying service ships.

## Owner decisions (settled)

From #584 and its owner-confirmed interaction comment, adopted without reopening:

- No selected project means **Global** scope, shown as such, never an ambiguous "all projects" view. A selector lists every activated (registered) project; choosing one shows and edits that project's configuration.
- Every registered PDB setting applicable to the scope appears; there is no separate GUI whitelist.
- Each row shows key, description, type, effective value, default, value source/inheritance, editable scope and whether a change applies live or needs a restart.
- Changes apply only on explicit **Save**; **Cancel** discards pending edits. **Reset** removes the override in the scope being edited, never an unrelated value.
- Restart-required changes are saved with "Restart PDB to apply". PDB never restarts itself.
- If another process changes the configuration while the user edits, the page warns and requires reload or reconciliation rather than overwriting.
- Reuse the registered config services and existing scope and secret boundaries. Not a raw file or environment editor; no credentials, no automatic Git commit, no forced migration.

## Shipped today

### Registry and repository scope

- The only registry is `CONFIG_KEYS` in `src/config/config.ts`. Each `ConfigKey` has `key`, `type` (`boolean` or `string`), optional `choices`, `nullable`, `defaultValue` and `description`. Registered keys: `briefing.engine` (`typescript`|`datalog`, default `datalog`), `complexity.enabled` (default true), `impact.enabled` (default true), `review.policy` (nullable, `legacy`|`codex-or-coderabbit`, default null), `processGuide` (default false). Retired keys are listed in `RETIRED_CONFIG_KEYS` and reported by `retiredKeyNotices`.
- Values are validated by `validateValue`; `parseConfig` yields `EffectiveSetting { key, value, source: "explicit" | "default" }`; `loadConfig` only reads.
- The files are the versioned `.github/triage.toml` (`TOML_CONFIG_PATH`) or the legacy `.github/triage.json` (`LEGACY_CONFIG_PATH`); both present is refused (`src/config/config.ts`).
- Scope is repository only: `configArgumentsFor` in `src/config/configcli.ts` refuses `--global`, `--system`, `--machine`, `--user` and `--scope`.
- Writes go through `updateConfig(target, changes, { expectedRaw? })`, where an `undefined` value unsets the key, and `replaceAtomically`, which writes a temp file, re-reads both config files and throws `ConflictError` (`"conflict"`) if either changed before renaming (`src/config/config.ts`). `expectedRaw` is an existing compare-and-swap precondition. This path takes **no lock**: the re-read and the rename are separate steps, so two writers (for example a CLI `pdb config set` and a second writer) can both pass the re-read and the later rename silently wins. The lock helpers below are not wired into it.
- Identity is separate: `identity.name` and `identity.triage_role` live in the Git-ignored root `pdb.toml` (`IDENTITY_FILE`) under `[agents.<entry>]`, written by the locked `setIdentity` (`src/config/identity.ts`).

### Safe writes

`src/config/filelock.ts` (`acquireFileLock`, exclusive create, never breaking a lock by age) and `src/config/safejson.ts` (`updateTextFile`, `updateJsonFile`: lock, read, decide, private temp file with fsync and verify, `checkUnchanged` re-read before rename, directory fsync; outcomes `not-written` and `committed-with-error`) implement [safe-shared-file-writes.md](safe-shared-file-writes.md).

### Serve

- No global config exists. Served projects come only from `--repo` and `--project` at startup (`servedSet` in `src/serve.ts`); nothing is persisted. Port, host and TTL are fixed at startup (`src/serve/options.ts`); there is no reload.
- Repository settings are read from the project per request (`src/config/engine-setting.ts`, `src/config/review-setting.ts`).
- The passive `GET /api/v1/diagnostics/config?repo=R` view (`serveSettings` in `src/serve/services.ts`) reports serve settings with source `argument` or `default`, and repository settings as `unknown` for a local project. It omits `review.policy`.
- The only POST routes are `/api/v1/refresh` (`src/serve/api.ts`) and `/mcp`. `guardRequest` (`src/serve/http.ts`) enforces Host and same-origin Origin before every route; `readJsonBody` requires `application/json` and caps bodies at `MAX_BODY_BYTES` (64 KiB, `src/serve/options.ts`). There is no CSRF token anywhere in `src`.

### Proposed elsewhere, not shipped

- Global scope, `--scope repository|global`, the global TOML file with `[serve]` (`serve.port`, `serve.ttl`, `serve.projects`), reload notification and a verified-instance control request: [serve-startup-configuration.md](serve-startup-configuration.md) (#443/#452).
- The serve write session (anti-CSRF cookie plus `X-PDB-CSRF` header, 30-minute idle expiry, in memory only), `expectedRevision` with 409 on staleness, typed applied/refused/partial results and read-back before showing "saved": [dashboard-assessment-edits.md](dashboard-assessment-edits.md) (#455).

This contract reuses both rather than defining a second write session or a second global store.

## Scopes and the setting model

Each registered key gains two descriptor fields, added to `CONFIG_KEYS` (no second registry):

- `scopes`: the scopes where it may be set, a subset of `global`, `repository`. Today every key is `repository`; #452 adds `global` keys (`serve.port`, `serve.ttl`, `serve.projects`).
- `applies`: `live` (read per request: every current repository key) or `restart` (read at startup: `serve.port`, `serve.ttl`, the edit-enable flag of #455).

Global keys never override repository keys, as [serve-startup-configuration.md](serve-startup-configuration.md) already specifies, so "inheritance" on this page means only **explicit in this scope** versus **default**. If a later ticket adds global defaults for repository keys, it extends `source` with `global`; this page displays whatever source the resolver returns and computes none itself.

`serve.projects` is shown read-only on this page in its first slices (registration is #452's command surface); editing the registration list is out of scope.

Identity keys are not settings on this page. The project view links to the identity state that `pdb setup identity` manages, read through the existing resolver, and shows how to change it; Global never shows or invents an identity.

## Typed service

Proposed module `src/config/settingsservice.ts`, used by the CLI (`pdb config`) and serve, with injected filesystem, clock and served-project registry:

```ts
type SettingsScope = { kind: "global" } | { kind: "repository"; repository: string };

interface SettingRow {
  key: string;
  description: string;
  type: "boolean" | "string" | "integer" | "duration" | "list";
  choices: readonly string[] | null;
  nullable: boolean;
  defaultValue: unknown;
  value: unknown | null; // effective value; null with known=false when unreadable
  known: boolean;
  source: "explicit" | "default" | "unknown";
  editable: boolean;
  notEditableReason: string | null; // e.g. "no verified local root", "set by --port argument"
  applies: "live" | "restart";
  pendingRestart: boolean; // saved value differs from the value this process started with
}

interface SettingsView {
  schemaVersion: 1;
  kind: "settings-view";
  scope: SettingsScope;
  revision: string | null; // sha256 of the raw scope file, "absent" when missing, null when unreadable
  file: { exists: boolean; format: "toml" | "json" | null; schemaVersion: number | null };
  rows: SettingRow[];
  warnings: string[]; // retired keys, future schema, unreadable file
}

interface SettingsChange {
  scope: SettingsScope;
  expectedRevision: string; // from the view the user edited
  set: Record<string, unknown>;
  reset: string[]; // keys whose override is removed in this scope
}

type SettingsResult =
  | { status: "applied"; view: SettingsView; restartRequired: string[] }
  | {
      status: "refused";
      code: SettingsErrorCode;
      message: string;
      fields: Record<string, string>;
      view: SettingsView | null;
    }
  | { status: "committed-with-error"; code: "READ_BACK_FAILED"; message: string; next: string[] };

type SettingsErrorCode =
  | "INVALID_VALUE" // per-field validation, nothing written
  | "UNKNOWN_KEY"
  | "NOT_EDITABLE_IN_SCOPE"
  | "CONFLICT" // revision differs: another process changed the file
  | "FUTURE_SCHEMA" // file schemaVersion newer than supported: never rewritten
  | "UNREADABLE" // malformed or unreadable: never overwritten
  | "BOTH_FORMATS" // triage.toml and triage.json both present
  | "NO_LOCAL_ROOT" // project registered without a verified local root
  | "LOCKED"; // lock held by another writer; nothing broken
```

Rules:

1. Validation of every changed field runs before any write; any invalid field refuses the whole change with per-field messages.
2. **Prerequisite (slice 0):** every config writer, including the existing CLI `updateConfig`, takes the same per-file lock (`acquireFileLock`, through `updateTextFile` with `checkUnchanged`) around its re-read and rename. Locking only the new service would leave the CLI race. The write is then `updateConfig` with `expectedRaw` matching `expectedRevision` under that lock. A mismatch is `CONFLICT` with the fresh view; nothing is merged automatically.
3. Unknown keys and values already present in the file are preserved byte-for-byte where the format allows (the existing TOML writer behaviour), and other scopes are never touched.
4. After writing, the service re-reads the file and returns the new view; if re-read fails it returns `committed-with-error` and the page says the save may have succeeded and asks for reload.
5. Global writes go to the #452 global file through the same locked writer; repository writes need a registered project with a verified local root, otherwise `NO_LOCAL_ROOT`. No write ever targets the server's cwd, a guessed clone or an unregistered path.
6. Values are never secrets today; any future secret-typed key is shown as "set" or "not set", never echoed, and is not writable here.

## HTTP API

Under the #455 write session; no separate token scheme.

- `GET /api/v1/settings?scope=global` or `?repo=R`: the `serve-read` envelope with a `SettingsView`. Read-only, local files only, no GitHub request. Malformed or unserved `repo` gives 400/403 as other routes do.
- `POST /api/v1/settings` with JSON `SettingsChange`, `X-PDB-CSRF` and the session cookie: returns `SettingsResult`. Status codes: 200 applied, 400 invalid, 403 missing or bad session or Origin, 409 `CONFLICT`, 422 `FUTURE_SCHEMA`/`UNREADABLE`/`BOTH_FORMATS`/`NO_LOCAL_ROOT`/`NOT_EDITABLE_IN_SCOPE`, 423 `LOCKED`.
- Writes are enabled only when edits are enabled under #455; otherwise the page is read-only and says how to enable edits, and the POST returns 403 `EDITS_DISABLED`.
- The existing passive `GET /api/v1/diagnostics/config` is unchanged and never writes.
- A saved global setting triggers the #452 reload notification only for keys marked `live` at global scope; `restart` keys are only saved. Serve never restarts itself.

## Page behaviour

- Route `/settings?repo=R`; without `repo` the scope label reads **Global**. Uses the shared toolbar of [dashboard-pipeline-metrics.md](dashboard-pipeline-metrics.md) (#605); the toolbar's project selection doubles as the scope selection, with an explicit "Global" choice.
- A form generated from `SettingRow` types: checkbox for boolean, select for `choices`, text with validation for others. Each row shows source, default, scope and "applies live" or "restart required".
- Edited rows are marked; a pending-change summary lists each change before Save. Save sends one `SettingsChange`; Cancel discards local edits; Reset per row adds it to `reset`.
- Switching scope or project with unsaved edits asks "Discard N unsaved changes?" and discards on confirmation; edits never carry across scopes. Late responses for a previous scope are discarded by request generation.
- On `CONFLICT` the page shows the changed rows from the fresh view and offers Reload (discarding edits) or re-apply edits onto the fresh view, which needs a new Save.
- After a successful save of a `restart` key the row and a page banner say "Restart PDB to apply".
- Unreadable or future-schema files show the repair guidance (`pdb config convert`, or upgrade PDB) and no editable form for that scope.
- Accessible labels, per-field error text tied to inputs with `aria-describedby`, keyboard-only use, narrow layout; all values escaped; no inline script; dashboard CSP.

## Implementation slices

0. **Shared config write lock.** Move `updateConfig`/`replaceAtomically` in `src/config/config.ts` onto the locked `updateTextFile` path for both `.github/triage.toml` and `.github/triage.json`. Checks: two concurrent `updateConfig` calls with injected filesystem interleaving produce one success and one `CONFLICT`, never a silent overwrite; a held lock reports `LOCKED` with the existing stuck-lock message; CLI output unchanged otherwise.
1. **Descriptor fields and read service.** Add `scopes` and `applies` to `CONFIG_KEYS`; `settingsView` for repository scope; `pdb config list --json` parity. Checks: every registered key appears exactly once; source explicit/default/unknown; unreadable, future and both-formats files produce warnings and no rows marked editable; no GitHub access.
2. **Read-only page and GET API** (repository scope; Global shows "not available until #452"). Checks: `/settings` without `repo` labelled Global; unserved repo refused without reads; project without a local root shows `NO_LOCAL_ROOT`; escaping; keyboard and narrow layout.
3. **Global scope read** after #452 merges. Checks: global keys listed with restart/live state; no identity at Global; `serve.projects` read-only.
4. **Write service and POST** after #455's write session ships. Checks: invalid fields refuse with nothing written; `CONFLICT` on concurrent CLI edit; unknown keys preserved; reset removes only the scoped override; lock held gives `LOCKED`; re-read failure gives `committed-with-error`; CSRF, Origin and edits-disabled refusals; cross-project and global/project race tests with injected filesystem.
5. **Editing UI.** Checks: pending summary, Save, Cancel, Reset, discard prompt on scope change, conflict reconciliation, restart banner, no automatic restart, packaged-install smoke test.

Slices 0–2 can start after this document merges, and slice 4 needs slice 0; slice 3 needs #452; slices 4–5 need #452 and #455's write session.
