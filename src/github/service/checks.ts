/**
 * Required-check evidence reads for the typed GH service (#926): the effective branch rules
 * (REST), legacy branch protection (GraphQL) and per-check requiredness on a PR head (GraphQL).
 * The documents and response validation live here; classification and hydration stay with
 * src/github/requiredchecks.ts. A missing or unreadable answer is a named gap, never advisory.
 */

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

type Query = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<Record<string, unknown>>;
type Rest = (path: string) => Promise<{ status: number | null; body: unknown }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Expected required checks for one base, from effective rulesets and legacy protection. */
export async function readBasePolicy(
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
          if (!isRecord(rule) || typeof rule.type !== "string") {
            gaps.push(`an effective rule for ${base} was unreadable`);
            continue;
          }
          if (rule.type !== "required_status_checks") continue;
          const checks = isRecord(rule.parameters) ? rule.parameters.required_status_checks : null;
          if (!Array.isArray(checks)) {
            gaps.push(`a required-status-checks rule for ${base} was unreadable`);
            continue;
          }
          for (const c of checks)
            if (
              isRecord(c) &&
              typeof c.context === "string" &&
              c.context.length > 0 &&
              (c.integration_id == null ||
                (typeof c.integration_id === "number" && Number.isSafeInteger(c.integration_id)))
            )
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
      else if (typeof rule.requiresStatusChecks !== "boolean")
        gaps.push(`legacy status-check requirement for ${base} was unreadable`);
      else if (rule.requiresStatusChecks === true) {
        if (!Array.isArray(rule.requiredStatusChecks))
          gaps.push(`legacy required checks for ${base} were unreadable`);
        else
          for (const c of rule.requiredStatusChecks)
            if (
              isRecord(c) &&
              typeof c.context === "string" &&
              c.context.length > 0 &&
              (c.app === null ||
                (isRecord(c.app) &&
                  typeof c.app.databaseId === "number" &&
                  Number.isSafeInteger(c.app.databaseId)))
            )
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
export async function readRequiredness(
  repository: string,
  pr: { number: number; headRefOid: string; baseRefName: string },
  query: Query,
): Promise<{ head: string; checks: RequiredChecks["checks"]; gaps: string[] }> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefName commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name databaseId isRequired(pullRequestNumber:$number) checkSuite{app{databaseId}}} ... on StatusContext{context isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage}}}}}}}}}`,
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
  if (isRecord(commit) && typeof commit.oid === "string" && commit.oid !== head)
    gaps.push("head checks changed while requiredness was read");
  const rollup = isRecord(commit) ? commit.statusCheckRollup : null;
  if (rollup === null && isRecord(commit)) return { head, checks: [], gaps };
  const contexts = isRecord(rollup) ? rollup.contexts : null;
  if (!isRecord(contexts) || !Array.isArray(contexts.nodes))
    return { head, checks: [], gaps: [...gaps, "the head checks could not be read"] };
  if (!isRecord(contexts.pageInfo) || typeof contexts.pageInfo.hasNextPage !== "boolean")
    gaps.push("head-check pagination coverage was not reported");
  else if (contexts.pageInfo.hasNextPage === true) gaps.push("more than 100 head checks");
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

/** Required-check reads bound to a GraphQL executor and a REST reader. */
export interface CheckReads {
  /** Expected required checks for a base branch; null with gaps when not read completely. */
  branchRequiredChecks(
    repository: string,
    base: string,
  ): Promise<{ expected: ExpectedCheck[] | null; gaps: string[] }>;
  /** Requiredness of each check on a PR's current head, with gaps for anything unread. */
  headRequiredness(
    repository: string,
    pr: { number: number; headRefOid: string; baseRefName: string },
  ): Promise<{ head: string; checks: RequiredChecks["checks"]; gaps: string[] }>;
}

export function checkReads(query: Query, rest: Rest): CheckReads {
  return {
    branchRequiredChecks: (repository, base) => readBasePolicy(repository, base, query, rest),
    headRequiredness: (repository, pr) => readRequiredness(repository, pr, query),
  };
}
