/**
 * Live application with request-context isolation (#808, doc/design/serve-live-application.md).
 *
 * Given a fresh saved global configuration, reconcile the running serve's context set (served
 * repositories with their verified local projects) against the saved registrations only — never
 * re-adding startup inputs such as the working directory or explicit `--repo`/`--project`
 * targets. Unchanged contexts are reused as-is (their cache entries stay valid); added contexts
 * are served fresh; changed and removed contexts are invalidated through the cache's epoch
 * boundary so obsolete in-flight reads cannot escape, and cross-repository dependency trees are
 * invalidated conservatively (any retained served repository's cached tree may reference a
 * changed/removed context, and re-computation is cheap). The outcome is reported to the
 * application-state service (#816) through `recordApplication`, acknowledging the key whenever
 * its saved *value* took effect — a reorder or case-only spelling change is a value change even
 * when no individual context is classified as changed.
 *
 * The module is pure over injected boundaries (served set, cache invalidation, optional saved
 * checkout verification, application-state recording): no filesystem, GitHub or timers.
 * Registration *at startup* and the verified-root check at startup stay in registration.ts
 * (#805); this is the runtime application of a later saved change.
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

/** Outcome of verifying one saved local root against its repository before serving it. */
export interface VerifiedSavedRoot {
  /**
   * The project to serve: the verified root, or undefined to serve this repository without a
   * local project (its saved root is missing, or now belongs to another repository).
   */
  readonly project: string | undefined;
  /** Non-fatal reason the saved root was not served as saved, when there is one. */
  readonly diagnostic?: string;
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
  /**
   * Drop the cached dependency trees (`collector "deps"`) of one repository. Called
   * conservatively across the retained served set whenever any context changed/removed, because
   * any retained tree may reference a changed/removed context.
   */
  invalidateDependencies?: (repository: string) => number;
  /**
   * Verify a saved local root belongs to its repository before serving it. Mirrors the startup
   * verified-checkout boundary (registration.ts); absent only in pure environments where no Git
   * boundary exists, in which case the saved root is accepted as-is.
   */
  verifyProject?: (repository: string, localRoot: string) => Promise<VerifiedSavedRoot>;
  /**
   * Report the applied/failed live keys to #816 and return the resulting view. Absent when the
   * running server has no application state (no verified global configuration boundary): the
   * served set and cache are still updated, but nothing is recorded.
   */
  record?: (result: {
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

/**
 * Deduplicate a saved projection by canonical repository, preserving startup's unambiguous
 * semantics (`registration.ts` `ServedSet`): a repo-only entry is refined by a verified root,
 * an identical verified root is kept once, and two different roots for one repository are a
 * configuration error rather than an order-dependent context set.
 */
export function dedupeSaved(served: readonly ServedEntry[]): ServedEntry[] {
  const byRepository = new Map<string, ServedEntry>();
  for (const entry of served) {
    const key = canonical(entry.repository);
    const existing = byRepository.get(key);
    if (!existing) {
      byRepository.set(key, entry);
      continue;
    }
    if (!entry.project) continue;
    if (!existing.project) {
      byRepository.set(key, { repository: existing.repository, project: entry.project });
      continue;
    }
    if (existing.project !== entry.project)
      throw new Error(
        `${entry.repository} has two saved local projects (${existing.project} and ${entry.project}); update serve.projects so one repository has one checkout.`,
      );
  }
  return [...byRepository.values()];
}

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
 * Two projections are the same *value* only when every entry matches in order, spelling and
 * project — the same strict comparison #816 applies to a saved key's complete value, so a
 * reorder or a case-only spelling change is a value change even though no individual per-repo
 * classification sees it.
 */
const sameValue = (left: readonly ServedEntry[], right: readonly ServedEntry[]): boolean =>
  left.length === right.length &&
  left.every(
    (entry, i) => sameEntry(entry, right[i]!) && entry.repository === right[i]!.repository,
  );

/**
 * Apply a fresh saved configuration to the running serve (#808). The fresh snapshot is the
 * registered configuration service's `LoadedGlobalConfig` read after the saved change landed
 * (config set, reload or page load). Reconciles the saved registrations against the current
 * served set, verifies saved local roots when a verified-root boundary is injected, invalidates
 * changed/removed contexts plus cross-repository dependency trees through the injected cache
 * boundary, and reports the applied `serve.projects` key to the application-state service.
 */
export async function applyLiveApplication(
  saved: LoadedGlobalConfig,
  boundaries: LiveApplicationBoundaries,
): Promise<LiveApplicationResult> {
  const stored = [...((saved.explicit.get("serve.projects") as GlobalProject[] | undefined) ?? [])];
  const projected = entriesFromSaved(stored);
  const diagnostics = [...projected.diagnostics];

  // Verify saved local roots against their repositories before serving them (mirrors the
  // startup boundary): a root that is missing or now belongs to another repository serves the
  // repository without a local project, and reports why.
  const verified: ServedEntry[] = [];
  for (const entry of projected.served) {
    if (entry.project === undefined || !boundaries.verifyProject) {
      verified.push(entry);
      continue;
    }
    const result = await boundaries.verifyProject(entry.repository, entry.project);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
    verified.push(
      result.project !== undefined
        ? { ...entry, project: result.project }
        : { repository: entry.repository },
    );
  }

  // Deduplicate by canonical repository before reconciling, mirroring startup's unambiguous
  // `ServedSet`: a repo-only entry is refined by a verified root, and two different roots for
  // one repository are a configuration error, never an order-dependent context set.
  const served = dedupeSaved(verified);
  const current = boundaries.currentServed();
  const changes = reconcileContexts(current, served);

  const changedOrRemoved = changes.filter((c) => c.change === "changed" || c.change === "removed");
  for (const change of changedOrRemoved) boundaries.invalidate(change.repository);
  if (changedOrRemoved.length > 0 && boundaries.invalidateDependencies) {
    // Conservative cross-repository invalidation: any retained served repository's cached
    // dependency tree may reference a changed/removed context, and re-computation is cheap.
    for (const entry of served) boundaries.invalidateDependencies(entry.repository);
  }

  // The write read succeeded (the caller passes an error instead when it did not), so the
  // `serve.projects` key applied — or was already current. Acknowledge it whenever its saved
  // *value* took effect (any context change implies a value change, and so does a reorder or a
  // case-only spelling change), so #816 never stays "pending-live" after a successful reload.
  const valueChanged = !sameValue(current, served);
  boundaries.record?.({
    revision: revisionOf(saved),
    // A saved registration for a host this build cannot serve is a diagnostic, not a key
    // failure: it remains saved and only narrows the served set.
    applied: valueChanged ? ["serve.projects"] : [],
    failed: [],
  });

  return { served, changes, diagnostics, revision: revisionOf(saved) };
}
