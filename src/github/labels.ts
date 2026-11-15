/**
 * Label filter resolution (#312, doc/design/briefing-focus-controls.md): resolve the requested
 * label names to the repository's canonical labels in one bounded GraphQL read. A confirmed
 * nonexistent label is named; a lookup that fails (permission, quota, timeout) is an unresolved
 * filter, never proof the label is absent. Nothing is created or renamed.
 */
import type { Query } from "./github.js";

/** At most this many distinct labels per filter. */
export const MAX_FILTER_LABELS = 8;
/** GitHub's label name limit. */
export const MAX_LABEL_LENGTH = 50;

export type LabelResolution =
  | { status: "resolved"; labels: string[] }
  | { status: "unknown"; missing: string[] }
  | { status: "unresolved"; why: string };

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

const safeCategory = (error: unknown): string => {
  const category =
    typeof error === "object" && error !== null && "evidence" in error
      ? (error as { evidence?: { category?: unknown } }).evidence?.category
      : undefined;
  return typeof category === "string" && /^[a-z][a-z-]{0,40}$/.test(category)
    ? category
    : "unknown";
};

/** Resolve already-normalized names to canonical repository labels with one query. */
export async function resolveLabels(
  repository: string,
  labels: readonly string[],
  query: Query,
): Promise<LabelResolution> {
  const [owner, name] = repository.split("/");
  const vars = Object.fromEntries(labels.map((label, i) => [`l${i}`, label]));
  // GitHub label names are unique ignoring case, but `label(name:)` matches exactly; a bounded
  // `labels(query:)` search in the same request finds the canonical spelling.
  const source = `query($owner:String!,$name:String!,${labels.map((_, i) => `$l${i}:String!`).join(",")}){repository(owner:$owner,name:$name){${labels.map((_, i) => `l${i}:label(name:$l${i}){name} s${i}:labels(first:100,query:$l${i}){nodes{name} pageInfo{hasNextPage}}`).join(" ")}}}`;
  let data: Record<string, unknown>;
  try {
    data = await query(source, { owner: owner!, name: name!, ...vars });
  } catch (error) {
    return {
      status: "unresolved",
      why: `the repository's labels could not be read (${safeCategory(error)})`,
    };
  }
  const repo = data.repository as Record<string, unknown> | null | undefined;
  if (!repo) return { status: "unresolved", why: "the repository could not be read" };
  const canonical: string[] = [];
  const missing: string[] = [];
  for (const [i, label] of labels.entries()) {
    const exact = repo[`l${i}`] as { name?: unknown } | null | undefined;
    const search = repo[`s${i}`] as
      | { nodes?: { name?: unknown }[]; pageInfo?: { hasNextPage?: unknown } }
      | null
      | undefined;
    if (exact && typeof exact.name === "string") {
      canonical.push(exact.name);
      continue;
    }
    // GitHub answers null for a label that does not exist; an absent or malformed field is
    // missing evidence, not a nonexistent label.
    if (exact !== null || !search || !Array.isArray(search.nodes))
      return { status: "unresolved", why: `the answer for label ${label} was malformed` };
    const match = search.nodes.find(
      (n) => typeof n.name === "string" && n.name.toLowerCase() === label.toLowerCase(),
    );
    if (match) canonical.push(match.name as string);
    // A search page that was cut short may hold the label beyond it: unresolved, not unknown.
    else if (search.pageInfo?.hasNextPage !== false)
      return {
        status: "unresolved",
        why: `too many labels resemble ${label} to confirm whether it exists`,
      };
    else missing.push(label);
  }
  return missing.length
    ? { status: "unknown", missing }
    : { status: "resolved", labels: canonical };
}
