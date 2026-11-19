/**
 * `pdb refine request` (#1095): the estimation reviewer's entry point to the shared refinement
 * service (src/workflow/refinement.ts, doc/design/estimation-refinement-loop.md). Parsing and
 * rendering only: the service plans and writes, and the next-step guidance is the native policy's
 * own text (`D-REFINE`), never restated here.
 */
import { parseArgs } from "node:util";
import { decisionGuidance, denialText } from "../rules/datalog/engine.js";
import { claimText } from "./claims.js";
import type { ClaimPlan, ClaimResult } from "./claims.js";
import { refinementLabel } from "./refinement.js";

export const refineUsage =
  "Usage: pdb refine request N [--agent NAME] --designer NAME --why TEXT --question TEXT [--question TEXT...] [--dependency owner/name#M...] [--dry-run] [--json] [--repo owner/name]";

export const refineHelp = `${refineUsage}

Request refinement when an estimation review finds there is not yet enough information to begin
implementation, assuming every listed dependency were complete. Records at least one concrete
blocking question for the designer, on the ticket, as a needs-human question
(doc/design/estimation-refinement-loop.md).

  --question TEXT       A concrete blocking question (repeatable; at least one, never blank)
  --why TEXT            Why the ticket cannot be estimated yet
  --designer NAME       Who the questions are routed to
  --dependency REF      Optional suggested missing blocker, owner/name#M (repeatable). Recorded
                        as a suggestion only; never added as a native dependency
  --agent NAME          Recording agent (defaults to the configured identity)
  --dry-run             Show the planned record without writing
  --json                Versioned machine-readable receipt

No implementation outline or dependency audit is required, and open dependencies do not prevent
the review. Needs refinement denies implementation pickup until the questions are resolved and the
ticket is re-estimated; it changes no assignment, claim, estimate or other label. The record is
written once (a retry is safe), then ${refinementLabel} is reconciled from a fresh read.
Exit: 0 done; 2 partly done or unverified; 1 refused or nothing done.
`;

export interface RefineRequestArgs {
  number: number;
  agent: string | undefined;
  designer: string;
  why: string;
  questions: string[];
  dependencies: string[];
  repo: string | undefined;
  json: boolean;
  dryRun: boolean;
}

/** Parse `refine request …`; throws the usage text on any malformed argument. */
export function refineArgumentsFor(
  args: string[],
  identityOptions: Record<string, { type: "string" | "boolean" }> = {},
): RefineRequestArgs & Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      designer: { type: "string" },
      why: { type: "string" },
      question: { type: "string", multiple: true },
      dependency: { type: "string", multiple: true },
      ...identityOptions,
    },
  });
  const [op, issue] = positionals;
  const questions = (values.question as string[] | undefined) ?? [];
  if (
    positionals.length !== 2 ||
    op !== "request" ||
    !/^[1-9]\d*$/.test(String(issue ?? "")) ||
    (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(String(values.agent))) ||
    !String(values.designer ?? "").trim() ||
    !String(values.why ?? "").trim() ||
    !questions.length
  )
    throw new Error(refineUsage);
  // Blank-only questions are refused before any read or write.
  if (questions.some((q) => !q.trim()))
    throw new Error(`Every --question must be a concrete, non-blank question.\n${refineUsage}`);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(values.repo)))
    throw new Error("--repo must be owner/name.");
  return {
    ...values,
    number: Number(issue),
    agent: values.agent as string | undefined,
    designer: String(values.designer).trim(),
    why: String(values.why).trim(),
    questions: questions.map((q) => q.trim()),
    dependencies: ((values.dependency as string[] | undefined) ?? []).map((d) => d.trim()),
    repo: values.repo as string | undefined,
    json: !!values.json,
    dryRun: !!values["dry-run"],
  };
}

/**
 * The designer's next step, from the native rule that offers it. It is stated only when this run
 * established it, by planning or writing a new request whose questions are therefore unanswered.
 * A replay of an already recorded request says so instead, because its questions may since have
 * been answered and a different rule may apply (#1136 review).
 */
export function refineGuidance(result: ClaimPlan | ClaimResult) {
  if (!result.ok) return null;
  const request = result.questionOpId ?? null;
  // An executed result counts only a comment step that completed; a plan (dry run) counts the
  // planned step. A failed or skipped write never yields guidance for a request that may not exist.
  const executed = "steps" in result && Array.isArray(result.steps);
  const recordedNow = executed
    ? result.steps!.some((s) => s.step === "comment" && s.status === "done")
    : result.changes.some((c) => c.step === "comment");
  if (executed && !recordedNow && result.changes.some((c) => c.step === "comment"))
    return {
      request,
      nextActor: null,
      rule: null,
      next: "The request was not confirmed as recorded; see the step statuses and retry.",
      pickup: null,
    };
  if (!recordedNow)
    return {
      request,
      nextActor: null,
      rule: null,
      next: "This request was already recorded; its questions may have been answered since. Read the ticket for its current state.",
      pickup: null,
    };
  const rule = decisionGuidance("D-REFINE");
  return {
    request,
    nextActor: "designer",
    rule: rule?.id ?? "D-REFINE",
    next: rule?.why ?? "",
    // The pickup denial's own explanation (D-DENY-REFINEMENT), not restated here.
    pickup: denialText("D-DENY-REFINEMENT"),
  };
}

/** The versioned JSON receipt. */
export function refineJson(result: ClaimPlan | ClaimResult): string {
  return (
    JSON.stringify(
      { schemaVersion: 1, kind: "refinement-request", ...result, guidance: refineGuidance(result) },
      null,
      2,
    ) + "\n"
  );
}

/** The text receipt: the shared mutation receipt plus the generated next step. */
export function refineText(result: ClaimPlan | ClaimResult, dryRun: boolean): string {
  const guidance = refineGuidance(result);
  const lines = [claimText(result as ClaimResult, dryRun).trimEnd()];
  if (guidance) {
    if (guidance.request) lines.push(`Refinement request: ${guidance.request}`);
    lines.push(
      guidance.rule
        ? `Next (${guidance.nextActor}, ${guidance.rule}): ${guidance.next}`
        : `Next: ${guidance.next}`,
    );
    if (guidance.pickup) lines.push(guidance.pickup);
  }
  return lines.join("\n") + "\n";
}
