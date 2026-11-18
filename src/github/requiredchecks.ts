/**
 * Required and advisory PR checks (#343, doc/design/required-advisory-checks.md).
 *
 * Only pending **required** checks make a PR wait. Requiredness comes from GitHub itself:
 * `isRequired(pullRequestNumber:)` bound to the selected PR for each visible check, and the
 * expected required set from the base branch's effective rules (rulesets, REST) and its legacy
 * branch protection (GraphQL). Nothing is inferred from a job's name, outcome or duration.
 * Missing or unreadable evidence is `unknown`, never advisory, and an expected required check
 * that has not reported is never passed.
 */
import type { CheckEvidence } from "../rules/datalog/check-types.js";
import type { Check } from "./types.js";
import { workflow } from "../workflow/definition.js";

export type { Requiredness, ExpectedCheck, RequiredChecks } from "./service/checks.js";
import type { RequiredChecks, Requiredness } from "./service/checks.js";
import { checkReads } from "./service/checks.js";

/** Minimum factual shape shared by snapshot and focused PR reads. */
export interface RequiredCheckSource {
  headRefOid: string;
  baseRefName: string;
  requiredChecks?: RequiredChecks;
  commits?: {
    nodes?: {
      commit: {
        oid?: string;
        statusCheckRollup?: {
          contexts: { nodes: Check[]; pageInfo?: { hasNextPage?: boolean } };
        } | null;
      };
    }[];
  };
}
type HydratableCheckSource = RequiredCheckSource & {
  number: number;
  state: string;
  isDraft?: boolean;
  url: string;
};

/** The shared classification every engine consumes. */
export interface CheckClassification {
  requiredPending: string[];
  advisoryPending: string[];
  /** Pending checks whose requiredness is unknown: treated like required (never advisory). */
  unknownPending: string[];
  /** Expected required checks that have not reported on this head. */
  missingRequired: string[];
}

const unfinished: readonly string[] = workflow.unfinished;
const outcomeOf = (c: {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
}) => c.conclusion ?? c.state ?? c.status ?? "UNKNOWN";

/**
 * Classify a PR's head checks with the required-check evidence (pure). A PR without evidence,
 * or evidence for another head or base, has every pending check `unknown`.
 */
export function classifyChecks(pr: RequiredCheckSource): CheckClassification {
  const contexts = pr.commits?.nodes?.[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const evidence = pr.requiredChecks;
  const bound = !!evidence && evidence.head === pr.headRefOid && evidence.base === pr.baseRefName;
  const requirednessOf = (check: (typeof contexts)[number]): Requiredness => {
    if (!bound) return "unknown";
    const name = check.name ?? check.context ?? "unnamed";
    const matches = evidence!.checks.filter(
      (c) =>
        c.name === name &&
        (check.databaseId == null || c.databaseId == null || c.databaseId === check.databaseId),
    );
    // Ambiguous duplicates stay unknown rather than borrowing another run's answer.
    const answers = new Set(matches.map((c) => c.required));
    return answers.size === 1 ? [...answers][0]! : "unknown";
  };
  const result: CheckClassification = {
    requiredPending: [],
    advisoryPending: [],
    unknownPending: [],
    missingRequired: [],
  };
  for (const check of contexts) {
    if (!unfinished.includes(outcomeOf(check))) continue;
    const name = check.name ?? check.context ?? "unnamed";
    const required = requirednessOf(check);
    (required === "required"
      ? result.requiredPending
      : required === "advisory"
        ? result.advisoryPending
        : result.unknownPending
    ).push(name);
  }
  const nameOf = (c: (typeof contexts)[number]) => c.name ?? c.context ?? "unnamed";
  if (bound) {
    // A run the later requiredness read saw but this snapshot's checks lack has an unexamined
    // outcome (it started after the snapshot): it waits, as unknown.
    for (const run of evidence!.checks) {
      const seen = contexts.some(
        (c) =>
          nameOf(c) === run.name &&
          (run.databaseId == null || c.databaseId == null || c.databaseId === run.databaseId),
      );
      if (!seen) result.unknownPending.push(run.name);
    }
    // An expected required check is reported only by a check in this snapshot (whose outcome
    // the rules examine), from the required app when the requirement names one.
    if (evidence!.expected)
      for (const expected of evidence!.expected) {
        const reported = contexts.some(
          (c) =>
            nameOf(c) === expected.context &&
            (expected.appId === null ||
              evidence!.checks.some(
                (run) =>
                  run.name === expected.context &&
                  run.appId === expected.appId &&
                  (run.databaseId == null || run.databaseId === c.databaseId),
              )),
        );
        if (!reported) result.missingRequired.push(expected.context);
      }
  }
  // Consumers match by name, so a name is advisory only when every pending run with that name
  // is advisory; one required or unknown run of the same name keeps it pending.
  const blocking = new Set([...result.requiredPending, ...result.unknownPending]);
  result.advisoryPending = result.advisoryPending.filter((name) => !blocking.has(name));
  return result;
}

/** Normalize source coverage and run identities; native policy interprets the outcomes. */
export function requiredCheckEvidence(pr: RequiredCheckSource): CheckEvidence {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  const contexts = rollup?.contexts.nodes ?? [];
  const evidence = pr.requiredChecks;
  const gaps = [...(evidence?.gaps ?? [])];
  const bound = !!evidence && evidence.head === pr.headRefOid && evidence.base === pr.baseRefName;
  if (commit?.oid !== undefined && commit.oid !== pr.headRefOid)
    gaps.push("observed checks belong to another head commit");
  if (!commit?.oid && contexts.some((check) => check.__typename === "StatusContext"))
    gaps.push("legacy status contexts lack their head commit binding");
  if (!bound) gaps.push("required-check evidence is absent or bound to another head/base");
  if (evidence?.expected == null) gaps.push("expected required checks were not completely read");
  if (
    rollup === undefined ||
    (rollup !== null &&
      (!rollup.contexts.pageInfo ||
        typeof rollup.contexts.pageInfo.hasNextPage !== "boolean" ||
        rollup.contexts.pageInfo.hasNextPage))
  )
    gaps.push("observed head checks were not completely read");
  const checks = contexts.map((check) => {
    const name = check.name ?? check.context ?? "unnamed";
    const matches = bound
      ? evidence!.checks.filter(
          (run) =>
            run.name === name &&
            (check.databaseId != null ? run.databaseId === check.databaseId : true),
        )
      : [];
    const sameName = contexts.filter((c) => (c.name ?? c.context ?? "unnamed") === name);
    const unambiguous = matches.length === 1 && (check.databaseId != null || sameName.length === 1);
    if (!unambiguous) gaps.push(`run identity or requiredness of ${name} is ambiguous`);
    let required: Requiredness = unambiguous ? matches[0]!.required : "unknown";
    if (
      bound &&
      evidence!.expected?.some(
        (expected) =>
          expected.context === name &&
          (expected.appId === null || (unambiguous && matches[0]!.appId === expected.appId)),
      )
    ) {
      if (required === "advisory") gaps.push(`conflicting requiredness for ${name}`);
      required = "required";
    }
    if (
      bound &&
      evidence!.expected !== null &&
      required === "required" &&
      !evidence!.expected.some(
        (expected) =>
          expected.context === name &&
          (expected.appId === null || (unambiguous && matches[0]!.appId === expected.appId)),
      )
    )
      gaps.push(`requiredness of ${name} is not explained by the expected policy`);
    if (
      typeof check.isRequired === "boolean" &&
      required !== "unknown" &&
      check.isRequired !== (required === "required")
    )
      gaps.push(`requiredness of ${name} changed between reads`);
    if (required === "unknown") gaps.push(`requiredness of ${name} is unknown`);
    return {
      name,
      outcome: outcomeOf(check),
      required,
      databaseId: check.databaseId ?? null,
      appId: unambiguous ? matches[0]!.appId : null,
    };
  });
  if (bound)
    for (const run of evidence!.checks) {
      if (
        !contexts.some(
          (c) =>
            (c.name ?? c.context ?? "unnamed") === run.name &&
            (run.databaseId === null || c.databaseId === run.databaseId),
        )
      )
        gaps.push(`the outcome of newly observed check ${run.name} was not read`);
    }
  return {
    complete: gaps.length === 0,
    gaps: [...new Set(gaps)],
    checks,
    missing: classifyChecks(pr).missingRequired,
  };
}

/** Selected open, non-draft PRs need requirement evidence even when visible checks are green. */
export const needsRequiredness = (pr: HydratableCheckSource): boolean =>
  pr.state === "OPEN" && !pr.isDraft;

type Query = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<Record<string, unknown>>;
type Rest = (path: string) => Promise<{ status: number | null; body: unknown }>;

/**
 * Hydrate selected open non-draft PRs, including green and no-check heads (#676). One base-policy read per distinct base (shared), one bound read per PR.
 * Returns warnings for incomplete evidence (each `${pr.url}: …`, which marks that PR incomplete).
 */
export async function hydrateRequiredChecks(
  repository: string,
  prs: HydratableCheckSource[],
  { query, rest }: { query: Query; rest: Rest },
): Promise<string[]> {
  const warnings: string[] = [];
  // Typed required-check reads over the caller's executors (#926): no queries composed here.
  const reads = checkReads(query, rest);
  const policies = new Map<string, ReturnType<typeof reads.branchRequiredChecks>>();
  for (const pr of prs.filter(needsRequiredness)) {
    const policy =
      policies.get(pr.baseRefName) ??
      policies
        .set(pr.baseRefName, reads.branchRequiredChecks(repository, pr.baseRefName))
        .get(pr.baseRefName)!;
    let read: Awaited<ReturnType<typeof reads.headRequiredness>>;
    try {
      read = await reads.headRequiredness(repository, pr);
    } catch {
      read = { head: "", checks: [], gaps: ["required checks could not be read"] };
    }
    const base = await policy;
    const gaps = [...read.gaps, ...base.gaps];
    pr.requiredChecks = {
      head: read.head,
      base: pr.baseRefName,
      checks: read.checks,
      expected: base.expected,
      gaps,
    };
    if (gaps.length)
      warnings.push(`${pr.url}: required-check evidence incomplete (${gaps.join("; ")}).`);
  }
  return warnings;
}
