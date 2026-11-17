# PDB serve application state: applied configuration and restart requirements

Contract for #816, child of #452. It refines the application-state row of [serve-configuration-layers.md](serve-configuration-layers.md) into a typed interface. Nothing here is implemented by this document. The configuration service it builds on is [configuration-service.md](configuration-service.md) (#804, shipped as `src/config/globalconfig.ts`).

## Boundary

| Layer                                 | Owns                                                                                                                                             | Does not own                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Configuration service (#804, shipped) | Reading, validating and writing `config.toml`; defaults; `LoadedGlobalConfig` snapshots (`explicit`, `settings`, `raw`); `globalChanges`         | Running-server state, what a change means for the process                                      |
| **Application state service (#816)**  | The running process's startup and applied snapshots; comparing them with the saved snapshot; live versus restart consequences with named reasons | Parsing or writing configuration; applying projects, request generations or cache invalidation |
| Live application (#808)               | Actually applying a live change (served projects, request isolation, cache invalidation) and reporting its outcome                               | Deciding whether a change is live or restart-only                                              |
| Reload (#813), Settings page (#584)   | Triggering reload; presenting the state                                                                                                          | Their own restart or consequence calculation                                                   |

Only `pdb serve` constructs this service. `pdb config` reads and writes through the configuration service directly and never depends on it. Its consequence table is a mechanical description of what the process can re-read, not workflow policy. Ticket and workflow decisions stay in the native rules, and nothing here ranks, admits or denies work.

## Consequences per key

One registry next to `GLOBAL_KEYS`, so a new key cannot be added without stating its consequence:

| Key              | Applies   | Reason shown                                                                                  |
| ---------------- | --------- | --------------------------------------------------------------------------------------------- |
| `serve.port`     | `restart` | "The listening port is bound at startup."                                                     |
| `serve.ttl`      | `restart` | "Cache lifetime is fixed when the cache is created." (existing semantics; not made live here) |
| `serve.projects` | `live`    | "Registered projects are applied by reload." (#808 performs the application)                  |

Repository-scope keys in `.github/triage.toml` are read per request today, so they are always current and need no tracking here. A key without a registry entry is reported as `restart` with the reason "consequence not declared", never assumed to be live.

## Snapshots

All in memory and never persisted. There is no dirty flag on disk.

- **startup:** the effective global settings the process started with, from the `LoadedGlobalConfig` read at startup. CLI overrides such as `--port` are recorded as the effective startup value, with their source.
- **applied:** the values the process is actually running with. It starts equal to startup, and advances only for `live` keys, and only when #808 reports a successful application of a specific saved revision.
- **saved:** the most recent configuration read, as a `LoadedGlobalConfig`. Every snapshot has a `Revision`: the digest of `raw` when the file exists, or the fixed value `"absent"` when it doesn't. An absent file is a valid snapshot of defaults, so it can be applied and reported like any other revision.

## State and result

```ts
/** A file-content digest, or "absent" when there is no config.toml (valid defaults). */
type Revision = string;

type KeyState =
  | { status: "in-sync" } // saved equals applied
  | { status: "pending-live"; reason: string } // live key differs, not yet applied
  | { status: "failed-live"; reason: string; error: string } // live application of this revision failed
  | { status: "restart-required"; reason: string } // restart key differs from the running value
  | { status: "overridden"; source: string }; // the running value comes from a CLI override

interface KeyView {
  key: string;
  applies: "live" | "restart";
  startup: GlobalValue;
  applied: GlobalValue;
  saved: GlobalValue | null; // null when the saved state is unreadable
  state: KeyState;
}

interface ApplicationStateView {
  schemaVersion: 1;
  startedAt: string;
  savedRevision: Revision | null; // null only when the saved config is unreadable or invalid
  appliedRevision: Revision; // the saved revision whose live keys were last applied
  keys: KeyView[];
  restartRequired: string[]; // keys whose state is restart-required, for one-line notices
  pendingLive: string[];
  readError: { code: string; message: string } | null; // invalid or unreadable saved config
}
```

Rules, each covered by a test:

1. **Initial state:** at startup every key that isn't overridden is `in-sync`, and `appliedRevision` is the startup revision. A key whose running value comes from a CLI override (for example `--port 9000` while the file says 4372) is `overridden`, never `restart-required`: the file wasn't what was applied, so a difference from it is expected.
2. **Restart keys:** a saved value that differs from the running value is `restart-required`. Reverting the saved value to the running value clears it, with no flag left over.
3. **Live keys:** a saved value that differs from applied is `pending-live` until #808 reports. Each key that succeeds advances its own `applied` value. `appliedRevision` advances to the reported revision only when every live key that differs in that revision succeeded. A failure leaves that key's `applied` unchanged and marks it `failed-live` with the error; a failure never implies success.
4. **No-op reload:** a reload is a no-op only when its saved revision equals `appliedRevision` **and** no key is `pending-live` or `failed-live`. It then changes nothing and reports nothing new.
5. **Partial application:** if #808 applies some live keys and not others, only the keys that succeeded advance. The rest stay `pending-live` or `failed-live` with their reasons, and `appliedRevision` doesn't move, so reloading the same unchanged file retries them. An acceptance case covers partial application followed by a successful retry of the same revision.
6. **Invalid or unreadable saved config:** `readError` is set, `saved` is `null` for every key, and `applied` keeps the last valid values, as serve-configuration-layers.md already requires.
7. **After a restart:** a new process starts with fresh snapshots, so earlier restart notices disappear by construction.
8. **Overridden keys:** an `overridden` key shows its saved value for information and never produces `pending-live` or `restart-required`, whatever is saved later. Its saved value takes effect only on a restart without the override. An acceptance case starts with `--port 9000` over a saved 4372, observes the unchanged file and expects `overridden` with no restart notice. It then saves 5000 and still expects no restart notice.
9. **Deleted file:** deleting `config.toml` and reloading gives a saved revision of `\"absent\"` with default values. For example, `serve.projects` becomes `[]`, a `pending-live` change that #808 can apply and report against `\"absent\"`, exactly as for any other revision. An acceptance case covers deletion followed by reload, both for success and for failure.

## Interface

```ts
interface ApplicationState {
  /** The current view, comparing the last observed saved snapshot with applied values. */
  view(): ApplicationStateView;
  /** Record a fresh configuration read (startup, reload or page load); returns the new view. */
  observe(saved: LoadedGlobalConfig | { error: GlobalConfigError }): ApplicationStateView;
  /** #808 reports the outcome of applying a saved revision's live keys. */
  recordApplication(result: {
    revision: Revision;
    applied: string[];
    failed: { key: string; error: string }[];
  }): ApplicationStateView;
}
function createApplicationState(
  startup: LoadedGlobalConfig,
  overrides: ReadonlyMap<string, GlobalValue>,
  clock: () => Date,
): ApplicationState;
```

The service makes no reads or writes itself: callers pass in the snapshots, so tests inject everything and need no filesystem, GitHub or timers. Its comparisons reuse `globalChanges` from the configuration service rather than a second comparison.

## Reconciliation with the Settings page contract

[serve-settings-page.md](serve-settings-page.md) shows each row's `applies` and returns `restartRequired` after a save. Those values now come from this service's `KeyView.applies` and `ApplicationStateView.restartRequired`. The settings service and page present them and must not compute their own. The owner decisions there are unchanged: restart-required changes are saved with "Restart PDB to apply", and PDB never restarts itself.

## Delivery and validation

One implementation PR after this contract merges: `src/serve/appstate.ts` with injected-input tests covering rules 1–9, plus the consequence registry next to `GLOBAL_KEYS`. Wiring into reload (#813), live application (#808) and the Settings page (#584) belongs to those tickets.
