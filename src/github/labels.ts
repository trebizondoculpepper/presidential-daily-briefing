/**
 * Label filter resolution (#312, doc/design/briefing-focus-controls.md): resolve the requested
 * label names to the repository's canonical labels in one bounded GraphQL read. A confirmed
 * nonexistent label is named; a lookup that fails (permission, quota, timeout) is an unresolved
 * filter, never proof the label is absent. Nothing is created or renamed.
 */
export { resolveLabels } from "./service/labels.js";
export type { LabelResolution } from "./service/labels.js";

/** At most this many distinct labels per filter. */
export const MAX_FILTER_LABELS = 8;
/** GitHub's label name limit. */
export const MAX_LABEL_LENGTH = 50;

/**
 * Validate requested names: nonempty, bounded, at most eight distinct ignoring case (duplicates
 * are idempotent). Returns the distinct names in request order, or the argument problem.
 */
export function normalizeLabelRequest(
  names: readonly string[],
): { ok: true; labels: string[] } | { ok: false; why: string } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) return { ok: false, why: "--label needs a nonempty label name." };
    if (name.length > MAX_LABEL_LENGTH)
      return { ok: false, why: `--label names are at most ${MAX_LABEL_LENGTH} characters.` };
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > MAX_FILTER_LABELS)
    return { ok: false, why: `At most ${MAX_FILTER_LABELS} distinct --label values per request.` };
  return { ok: true, labels: out };
}

/**
 * Resolve a label filter against the labels of a snapshot's own items, with no request (#371):
 * for offline and stale reads. A name seen on an item takes its spelling there
 * (case-insensitively); an unseen name is kept as requested and reported as not verified.
 */
export function labelsFromSnapshot(
  items: readonly { labels: { nodes: readonly { name: string }[] } }[],
  requested: readonly string[],
): { labels: string[]; unverified: string[] } {
  const seen = new Map<string, string>();
  for (const item of items)
    for (const label of item.labels.nodes) seen.set(label.name.toLowerCase(), label.name);
  const labels: string[] = [];
  const unverified: string[] = [];
  for (const name of requested) {
    const known = seen.get(name.toLowerCase());
    labels.push(known ?? name);
    if (!known) unverified.push(name);
  }
  return { labels, unverified };
}
