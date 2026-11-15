/**
 * Cache boundary for service mutations (#453). It adds no HTTP route or permission.
 * The caller invokes the existing live mutation service and classifies its real outcome;
 * HTTP status or a partially completed remote operation is never guessed to be a refusal.
 */
import type { ServeCache } from "./cache.js";
export type WriteOutcome = "applied" | "partial" | "unknown" | "refused" | "unchanged";

/**
 * Conservative initial policy: invalidate every context in this server, including known
 * served cross-repository dependants, on successful or ambiguous writes. Unrelated CLI or
 * external writes remain subject to TTL/manual refresh. No cross-process notification.
 */
export async function serviceMutation<T>(
  cache: ServeCache,
  write: () => Promise<T>,
  outcome: (result: T) => WriteOutcome,
): Promise<T> {
  try {
    const result = await write();
    const state = outcome(result);
    if (state !== "refused" && state !== "unchanged") cache.refresh();
    return result;
  } catch (error) {
    // A rejected promise can follow an applied remote step. Never retain cached facts then.
    cache.refresh();
    throw error;
  }
}
