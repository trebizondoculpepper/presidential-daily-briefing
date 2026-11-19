/**
 * `pdb refine request|resolve|status` (#1095, #1096): the CLI over the shared refinement service
 * (src/workflow/refinement.ts, doc/design/estimation-refinement-loop.md). Parsing and rendering
 * only: the service plans and writes, and next-step guidance is the native policy's own text
 * (`D-REFINE`, `D-REESTIMATE`), never restated here. Questions are answered with the existing
 * trusted `pdb question resolve|withdraw`; nothing here answers on a human's behalf.
 */
import { parseArgs } from "node:util";
import { decisionGuidance, denialText } from "../rules/datalog/engine.js";
import { claimText } from "./claims.js";
import type { ClaimPlan, ClaimResult } from "./claims.js";
import { refinementLabel } from "./refinement.js";
import type { RefinementStatus } from "./refinement.js";

export const refineUsage =
  "Usage: pdb refine request N [--agent NAME] --designer NAME --why TEXT --question TEXT [--question TEXT...] [--dependency owner/name#M...] [--dry-run] [--json] [--repo owner/name]";
export const refineResolveUsage =
  "Usage: pdb refine resolve N [--agent NAME] --request OPID --why TEXT [--dry-run] [--json] [--repo owner/name]";
export const refineStatusUsage =
  "Usage: pdb refine status N [--agent NAME] [--json] [--repo owner/name]";

export const refineHelp = `${refineUsage}
${refineResolveUsage}
${refineStatusUsage}

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
refine status lists each request with its question ID (the question's comment URL), the
question's outcome and the request's state. Answer or withdraw a question with the existing
pdb question resolve|withdraw N --question URL --why TEXT; this command never answers for you.

refine resolve clears one request once its question is settled by a trusted answer and no newer
request is open (--request is the 16-hex request id from refine status). The ticket returns for
estimation: resolving adds no readiness label, makes no estimate, closes nothing and claims
nothing. ${refinementLabel} is removed only when no other request stays outstanding.
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

export interface RefineResolveArgs {
  number: number;
  agent: string | undefined;
  request: string;
  why: string;
  repo: string | undefined;
  json: boolean;
  dryRun: boolean;
}

/** Parse `refine resolve …`; throws the usage text on any malformed argument. */
export function refineResolveArgumentsFor(
  args: string[],
  identityOptions: Record<string, { type: "string" | "boolean" }> = {},
): RefineResolveArgs & Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      request: { type: "string" },
      why: { type: "string" },
      ...identityOptions,
    },
  });
  const [op, issue] = positionals;
  if (
    positionals.length !== 2 ||
    op !== "resolve" ||
    !/^[1-9]\d*$/.test(String(issue ?? "")) ||
    (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(String(values.agent))) ||
    !/^[0-9a-f]{16}$/.test(String(values.request ?? "")) ||
    !String(values.why ?? "").trim()
  )
    throw new Error(refineResolveUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(values.repo)))
    throw new Error("--repo must be owner/name.");
  return {
    ...values,
    number: Number(issue),
    agent: values.agent as string | undefined,
    request: String(values.request),
    why: String(values.why).trim(),
    repo: values.repo as string | undefined,
    json: !!values.json,
    dryRun: !!values["dry-run"],
  };
}

export interface RefineStatusArgs {
  number: number;
  agent: string | undefined;
  repo: string | undefined;
  json: boolean;
}

/** Parse `refine status …`; throws the usage text on any malformed argument. */
export function refineStatusArgumentsFor(
  args: string[],
  identityOptions: Record<string, { type: "string" | "boolean" }> = {},
): RefineStatusArgs & Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      agent: { type: "string" },
      ...identityOptions,
    },
  });
  const [op, issue] = positionals;
  if (
    positionals.length !== 2 ||
    op !== "status" ||
    !/^[1-9]\d*$/.test(String(issue ?? "")) ||
    (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(String(values.agent)))
  )
    throw new Error(refineStatusUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(values.repo)))
    throw new Error("--repo must be owner/name.");
  return {
    ...values,
    number: Number(issue),
    agent: values.agent as string | undefined,
    repo: values.repo as string | undefined,
    json: !!values.json,
  };
}

/**
 * The next step after a resolve, from the native rule that offers it (D-REESTIMATE). As for a
 * request, it is stated only when this run planned or wrote the resolve record; a replay or a
 * failed write says so instead of claiming a state the result does not establish.
 */
export function resolveGuidance(
  result: ClaimPlan | ClaimResult,
  request: string,
  /** Requests other than this one still unresolved after the run, from a fresh status read. */
  stillOpen: string[] | null = [],
) {
  if (!result.ok) return null;
  const executed = "steps" in result && Array.isArray(result.steps);
  const planned = result.changes.some((c) => c.step === "comment");
  const recordedNow = executed
    ? result.steps!.some((s) => s.step === "comment" && s.status === "done")
    : planned;
  if (executed && !recordedNow && planned)
    return {
      request,
      nextActor: null,
      rule: null,
      next: "The resolve was not confirmed as recorded; see the step statuses and retry.",
      pickup: null,
    };
  if (!recordedNow)
    return {
      request,
      nextActor: null,
      rule: null,
      next: "This request was already resolved; read the ticket for its current state.",
      pickup: null,
    };
  // The resulting records decide which native state applies (#1139 review): while another request
  // stays open the ticket still needs refinement; only with none left does it await re-estimation.
  if (stillOpen === null)
    return {
      request,
      nextActor: null,
      rule: null,
      next: "The ticket's remaining refinement could not be read; run pdb refine status for its state.",
      pickup: null,
    };
  if (stillOpen.length) {
    const refine = decisionGuidance("D-REFINE");
    return {
      request,
      nextActor: "designer",
      rule: refine?.id ?? "D-REFINE",
      next: `${refine?.why ?? ""} Still open: ${stillOpen.join(", ")}.`,
      pickup: denialText("D-DENY-REFINEMENT"),
    };
  }
  const rule = decisionGuidance("D-REESTIMATE");
  return {
    request,
    nextActor: "estimator",
    rule: rule?.id ?? "D-REESTIMATE",
    next: rule?.why ?? "",
    // The re-estimation denial's own explanation, not restated here.
    pickup: denialText("D-DENY-REESTIMATE"),
  };
}

export function resolveJson(
  result: ClaimPlan | ClaimResult,
  request: string,
  stillOpen: string[] | null = [],
): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "refinement-resolve",
        ...result,
        guidance: resolveGuidance(result, request, stillOpen),
      },
      null,
      2,
    ) + "\n"
  );
}

export function resolveText(
  result: ClaimPlan | ClaimResult,
  request: string,
  dryRun: boolean,
  stillOpen: string[] | null = [],
): string {
  const guidance = resolveGuidance(result, request, stillOpen);
  const lines = [claimText(result as ClaimResult, dryRun).trimEnd()];
  if (guidance) {
    lines.push(`Refinement request: ${guidance.request}`);
    lines.push(
      guidance.rule
        ? `Next (${guidance.nextActor}, ${guidance.rule}): ${guidance.next}`
        : `Next: ${guidance.next}`,
    );
    if (guidance.pickup) lines.push(guidance.pickup);
  }
  return lines.join("\n") + "\n";
}

export function statusJson(status: RefinementStatus): string {
  return JSON.stringify({ schemaVersion: 1, kind: "refinement-status", ...status }, null, 2) + "\n";
}

/** The text listing: one block per request, unanswered questions shown as such. */
export function statusText(status: RefinementStatus): string {
  if (!status.ok) return claimText({ ...status, exitCode: 1 } as ClaimResult, false);
  const lines = [`${status.facts.url} ${status.facts.title}`];
  if (!status.requests.length) lines.push("No refinement request is recorded.");
  for (const q of status.requests) {
    lines.push(
      `- request ${q.request}: ${q.state}`,
      `    question: ${q.question}`,
      `    answer: ${q.outcome === "none" ? "not yet answered (pdb question resolve|withdraw)" : q.outcome === "resolve" ? "resolved" : "withdrawn"}`,
      ...(q.resolvedBy ? [`    resolved by: ${q.resolvedBy}`] : []),
      ...(q.dependencies.length
        ? [`    suggested dependencies (not applied): ${q.dependencies.join(", ")}`]
        : []),
    );
  }
  lines.push(`${refinementLabel}: ${status.labelPresent ? "present" : "absent"}`);
  if (status.unknown.length)
    lines.push(
      `INCOMPLETE: some records could not be verified, so this listing may be missing requests or answers: ${status.unknown.join("; ")}`,
    );
  return lines.join("\n") + "\n";
}
