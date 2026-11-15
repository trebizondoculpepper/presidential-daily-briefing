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
import type { PullRequest } from "./types.js";
import { workflow } from "../workflow/definition.js";

export type Requiredness = "required" | "advisory" | "unknown";

/** One expected required check: its context name and, when constrained, the app that must report it. */
export interface ExpectedCheck {
  context: string;
  appId: number | null;
}

/** What was read for one PR's head and base; attached to the PR as `requiredChecks`. */
export interface RequiredChecks {
  head: string;
  base: string;
  /** Requiredness per visible check, matched to the rollup by name and app/run identity. */
  checks: {
    name: string;
    databaseId: number | null;
    appId: number | null;
    required: Requiredness;
  }[];
  /** Expected required checks from rulesets and legacy protection; null when not read completely. */
  expected: ExpectedCheck[] | null;
  /** Named gaps; empty only when every source was read completely for this head and base. */
  gaps: string[];
}

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
const outcomeOf = (c: { conclusion?: string | null; state?: string; status?: string }) =>
  c.conclusion ?? c.state ?? c.status ?? "UNKNOWN";

/**
 * Classify a PR's head checks with the required-check evidence (pure). A PR without evidence,
 * or evidence for another head or base, has every pending check `unknown`.
 */
export function classifyChecks(pr: PullRequest): CheckClassification {
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

/** Whether a PR's checks are worth classifying: open, not a draft, with an unfinished check. */
export const needsRequiredness = (pr: PullRequest): boolean =>
  pr.state === "OPEN" &&
  !pr.isDraft &&
  (pr.commits?.nodes?.[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).some((c) =>
    unfinished.includes(outcomeOf(c)),
  );

type Query = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<Record<string, unknown>>;
type Rest = (path: string) => Promise<{ status: number | null; body: unknown }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Expected required checks for one base, from effective rulesets and legacy protection. */
async function readBasePolicy(
  repository: string,
  base: string,
  query: Query,
  rest: Rest,
): Promise<{ expected: ExpectedCheck[] | null; gaps: string[] }> {
  const gaps: string[] = [];
  const expected: ExpectedCheck[] = [];
  // Effective rules include higher-level rulesets; evaluate/disabled rulesets are not returned.
  try {
    const answer = await rest(
      `repos/${repository}/rules/branches/${encodeURIComponent(base)}?per_page=100`,
    );
    if (answer.status !== 200)
      gaps.push(`effective rules for ${base} answered ${answer.status ?? "no status"}`);
    else {
      const rules: unknown =
        typeof answer.body === "string" ? JSON.parse(answer.body) : answer.body;
      if (!Array.isArray(rules)) gaps.push(`effective rules for ${base} were malformed`);
      else {
        if (rules.length >= 100) gaps.push(`more than 100 effective rules for ${base}`);
        for (const rule of rules) {
          if (!isRecord(rule) || rule.type !== "required_status_checks") continue;
          const checks = isRecord(rule.parameters) ? rule.parameters.required_status_checks : null;
          if (!Array.isArray(checks)) {
            gaps.push(`a required-status-checks rule for ${base} was unreadable`);
            continue;
          }
          for (const c of checks)
            if (isRecord(c) && typeof c.context === "string")
              expected.push({
                context: c.context,
                appId: typeof c.integration_id === "number" ? c.integration_id : null,
              });
            else gaps.push(`a required status check for ${base} was unreadable`);
        }
      }
    }
  } catch {
    gaps.push(`effective rules for ${base} could not be read`);
  }
  // Legacy protection: a successfully read null rule means no legacy rule; an error does not.
  try {
    const [owner, name] = repository.split("/");
    const data = await query(
      `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{requiresStatusChecks requiredStatusChecks{context app{databaseId}}}}}}`,
      { owner: owner!, name: name!, ref: `refs/heads/${base}` },
    );
    const repo = data.repository;
    const ref = isRecord(repo) ? repo.ref : undefined;
    if (!isRecord(ref)) gaps.push(`the base branch ${base} could not be read`);
    else if (ref.branchProtectionRule !== null) {
      const rule = ref.branchProtectionRule;
      if (!isRecord(rule)) gaps.push(`legacy protection for ${base} was unreadable`);
      else if (rule.requiresStatusChecks === true) {
        if (!Array.isArray(rule.requiredStatusChecks))
          gaps.push(`legacy required checks for ${base} were unreadable`);
        else
          for (const c of rule.requiredStatusChecks)
            if (isRecord(c) && typeof c.context === "string")
              expected.push({
                context: c.context,
                appId:
                  isRecord(c.app) && typeof c.app.databaseId === "number" ? c.app.databaseId : null,
              });
            else gaps.push(`a legacy required check for ${base} was unreadable`);
      }
    }
  } catch {
    gaps.push(`legacy protection for ${base} could not be read`);
  }
  // Equivalent duplicates collapse; source attribution is not needed to decide.
  const unique = [
    ...new Map(expected.map((e) => [`${e.context}\u0000${e.appId ?? ""}`, e])).values(),
  ];
  return { expected: gaps.length ? null : unique, gaps };
}

/** Per-check requiredness for one PR, bound to that PR and its current head. */
async function readRequiredness(
  repository: string,
  pr: PullRequest,
  query: Query,
): Promise<{ head: string; checks: RequiredChecks["checks"]; gaps: string[] }> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefName commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name databaseId isRequired(pullRequestNumber:$number) checkSuite{app{databaseId}}} ... on StatusContext{context isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage}}}}}}}}}`,
    { owner: owner!, name: name!, number: pr.number },
  );
  const gaps: string[] = [];
  const read = isRecord(data.repository) ? data.repository.pullRequest : null;
  if (!isRecord(read))
    return { head: "", checks: [], gaps: ["the pull request could not be read"] };
  const head = typeof read.headRefOid === "string" ? read.headRefOid : "";
  if (head !== pr.headRefOid || read.baseRefName !== pr.baseRefName)
    gaps.push("the head or base changed while required checks were read");
  const commits = isRecord(read.commits) ? read.commits.nodes : null;
  const commit = Array.isArray(commits) && isRecord(commits[0]) ? commits[0].commit : null;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : null;
  const contexts = isRecord(rollup) ? rollup.contexts : null;
  if (!isRecord(contexts) || !Array.isArray(contexts.nodes))
    return { head, checks: [], gaps: [...gaps, "the head checks could not be read"] };
  if (isRecord(contexts.pageInfo) && contexts.pageInfo.hasNextPage === true)
    gaps.push("more than 100 head checks");
  const checks = contexts.nodes.filter(isRecord).map((c) => ({
    name:
      typeof c.name === "string" ? c.name : typeof c.context === "string" ? c.context : "unnamed",
    databaseId: typeof c.databaseId === "number" ? c.databaseId : null,
    appId:
      isRecord(c.checkSuite) &&
      isRecord(c.checkSuite.app) &&
      typeof c.checkSuite.app.databaseId === "number"
        ? c.checkSuite.app.databaseId
        : null,
    // A missing or null answer is unknown, never advisory.
    required: (c.isRequired === true
      ? "required"
      : c.isRequired === false
        ? "advisory"
        : "unknown") as Requiredness,
  }));
  return { head, checks, gaps };
}

/**
 * Hydrate required-check evidence for the PRs where it decides waiting: open, non-draft, with an
 * unfinished check. One base-policy read per distinct base (shared), one bound read per PR.
 * Returns warnings for incomplete evidence (each `${pr.url}: …`, which marks that PR incomplete).
 */
export async function hydrateRequiredChecks(
  repository: string,
  prs: PullRequest[],
  { query, rest }: { query: Query; rest: Rest },
): Promise<string[]> {
  const warnings: string[] = [];
  const policies = new Map<string, ReturnType<typeof readBasePolicy>>();
  for (const pr of prs.filter(needsRequiredness)) {
    const policy =
      policies.get(pr.baseRefName) ??
      policies
        .set(pr.baseRefName, readBasePolicy(repository, pr.baseRefName, query, rest))
        .get(pr.baseRefName)!;
    let read: Awaited<ReturnType<typeof readRequiredness>>;
    try {
      read = await readRequiredness(repository, pr, query);
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
