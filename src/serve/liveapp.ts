/**
 * Live application with request-context isolation (#808, doc/design/serve-live-application.md).
 *
 * Given a fresh saved global configuration, reconcile the running serve's context set (served
 * repositories with their verified local projects) against the saved registrations only — never
 * re-adding startup inputs such as the working directory or explicit `--repo`/`--project`
 * targets. Unchanged contexts are reused as-is (their cache entries stay valid); added contexts
 * are served fresh; changed and removed contexts are invalidated through the cache's epoch
 * boundary so obsolete in-flight reads cannot escape. The outcome is reported to the
 * application-state service (#816) through `recordApplication`.
 *
 * The module is pure over injected boundaries (served set, cache invalidation, application-state
 * recording): no filesystem, GitHub or timers. Registration *at startup* stays in
 * registration.ts (#805); this is the runtime application of a later saved change.
 */
import type { GlobalProject, LoadedGlobalConfig } from "../config/globalconfig.js";
import { revisionOf, type ApplicationStateView, type Revision } from "./appstate.js";

export interface ServedEntry {
  readonly repository: string;
  /** Verified local checkout project; absent for a repo-only entry. */
  readonly project?: string;
}

export type ContextChange =
  | { repository: string; change: "added" | "removed" | "unchanged" }
  | { repository: string; change: "changed"; project: string | undefined };

export interface LiveApplicationResult {
  /** The new served set, in saved order. */
  readonly served: readonly ServedEntry[];
  /** Per-repository change classification after reconciliation. */
  readonly changes: readonly ContextChange[];
  /** Non-fatal diagnostics (e.g. a registered host this build cannot serve). */
  readonly diagnostics: readonly string[];
  /** Revision whose live keys were applied (or "absent"), for appstate. */
  readonly revision: Revision;
}

/** Boundaries the live-application step needs; the cache and appstate are injected. */
export interface LiveApplicationBoundaries {
  /** The served set the server is currently running with. */
  currentServed: () => readonly ServedEntry[];
  /**
   * Invalidate one repository's cache: bump its refresh epoch and drop its entries so reads
   * started before the change cannot insert. Returns the number of entries dropped.
   */
  invalidate: (repository: string) => number;
  /** Report the applied/failed live keys to #816 and return the resulting view. */
  record: (result: {
    revision: Revision;
    applied: string[];
    failed: { key: string; error: string }[];
  }) => ApplicationStateView;
}

/** The saved set, projected from the global configuration (host github.com only). */
export function entriesFromSaved(projects: readonly GlobalProject[]): {
  served: ServedEntry[];
  diagnostics: string[];
} {
  const served: ServedEntry[] = [];
  const diagnostics: string[] = [];
  for (const entry of projects) {
    if (entry.host.toLowerCase() !== "github.com") {
      diagnostics.push(
        `saved project ${entry.repository} is registered for ${entry.host}, which this build cannot serve; it is kept in the configuration and not served.`,
      );
      continue;
    }
    served.push(
      entry.localRoot !== undefined
        ? { repository: entry.repository, project: entry.localRoot }
        : { repository: entry.repository },
    );
  }
  return { served, diagnostics };
}

const canonical = (repository: string): string => repository.toLowerCase();
const sameEntry = (left: ServedEntry, right: ServedEntry): boolean =>
  canonical(left.repository) === canonical(right.repository) &&
  (left.project ?? null) === (right.project ?? null);

/** Reconcile the saved-set projection against the current served set (pure). */
export function reconcileContexts(
  current: readonly ServedEntry[],
  target: readonly ServedEntry[],
): ContextChange[] {
  const byKey = new Map<string, ServedEntry>();
  for (const entry of current) byKey.set(canonical(entry.repository), entry);
  const changes: ContextChange[] = [];
  const seen = new Set<string>();
  for (const entry of target) {
    const key = canonical(entry.repository);
    seen.add(key);
    const existing = byKey.get(key);
    if (!existing) changes.push({ repository: entry.repository, change: "added" });
    else if (!sameEntry(existing, entry))
      changes.push({ repository: entry.repository, change: "changed", project: entry.project });
    else changes.push({ repository: entry.repository, change: "unchanged" });
  }
  for (const entry of current) {
    const key = canonical(entry.repository);
    if (!seen.has(key)) changes.push({ repository: entry.repository, change: "removed" });
  }
  return changes;
}

/**
 * Apply a fresh saved configuration to the running serve (#808). The fresh snapshot is the
 * registered configuration service's `LoadedGlobalConfig` read after the saved change landed
 * (config set, reload or page load). Reconciles the saved registrations against the current
 * served set, invalidates changed/removed contexts through the injected cache boundary, and
 * reports the applied `serve.projects` key to the application-state service.
 */
export async function applyLiveApplication(
  saved: LoadedGlobalConfig,
  boundaries: LiveApplicationBoundaries,
): Promise<LiveApplicationResult> {
  const stored = [...((saved.explicit.get("serve.projects") as GlobalProject[] | undefined) ?? [])];
  const { served, diagnostics } = entriesFromSaved(stored);
  const current = boundaries.currentServed();
  const changes = reconcileContexts(current, served);

  for (const change of changes) {
    if (change.change === "changed" || change.change === "removed") {
      boundaries.invalidate(change.repository);
    }
  }

  // The write read succeeded (the caller passes an error instead when it did not), so the
  // `serve.projects` key applied — or was already current. A saved registration for a host this
  // build cannot serve is a diagnostic, not a key failure: it remains saved and only narrows
  // the served set.
  const anyChanged = changes.some((c) => c.change !== "unchanged");
  boundaries.record({
    revision: revisionOf(saved),
    applied: anyChanged ? ["serve.projects"] : [],
    failed: [],
  });

  return { served, changes, diagnostics, revision: revisionOf(saved) };
}
