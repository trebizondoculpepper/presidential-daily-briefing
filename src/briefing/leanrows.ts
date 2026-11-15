/**
 * Lean ranked rows (#487, doc/design/lean-briefing-rows.md): the shared default text row for CLI
 * and MCP. Presentation only: the action, its order, the engine's own reason and the commands come
 * from the ranked model unchanged; nothing here scores, re-ranks or re-narrates a decision.
 */

/** Short action labels. They name the action; they never rewrite the rule's explanation. */
const labels: Record<string, string> = {
  "addressed-response": "Respond",
  "pr-follow-up": "Follow up PR",
  decide: "Decide",
  document: "Document",
  "design-review": "Review design PR",
  "continue-implementation": "Continue",
  implement: "Implement",
  "estimate-complexity": "Estimate complexity",
  "assess-impact": "Assess impact",
  "inspect-assessment": "Inspect assessment",
  inspect: "Inspect",
  design: "Design",
};
export const actionLabel = (kind: string): string => labels[kind] ?? kind;

/** The fields of a ranked action a lean row reads. */
export interface LeanRowInput {
  kind: string;
  target: string;
  nextCommand?: string | null;
  thenCommand?: string | null;
  inspection?: string | null;
  unlocks?: number;
  unlocksUnknown?: readonly string[];
}

/**
 * Proven unlock utility, only when it adds information: a positive count (a lower bound when
 * evidence is incomplete), or incomplete evidence with none observed, which is not proof of none.
 * Zero with complete evidence prints nothing.
 */
function unlocksText(item: LeanRowInput): string | null {
  const n = item.unlocks ?? 0;
  const unknown = item.unlocksUnknown ?? [];
  if (n > 0) return `Unlocks ${unknown.length ? "at least " : ""}${n} otherwise-ready ticket(s).`;
  if (unknown.length) return `Unlocks unknown: ${unknown.join("; ")}.`;
  return null;
}

/**
 * One row: ordinal rank (its position in this list, not a score), label, number and title, the
 * single existing reason, unlock evidence when it matters, the verbatim commands (or the
 * inspection path when there is no command) and one link.
 */
export function leanRow(
  rank: number,
  item: LeanRowInput,
  subject: { number: number | string; title: string },
  why: string | null | undefined,
  fallbackInspection?: string,
): string {
  const lines = [`${rank}. ${actionLabel(item.kind)} #${subject.number}: ${subject.title}`];
  if (why) lines.push(`   ${why}`);
  const unlocks = unlocksText(item);
  if (unlocks) lines.push(`   ${unlocks}`);
  if (item.nextCommand) {
    lines.push(`   Next: ${item.nextCommand}`);
    if (item.thenCommand) lines.push(`   Then: ${item.thenCommand}`);
  } else {
    const inspect = item.inspection ?? fallbackInspection;
    if (inspect) lines.push(`   Inspect: ${inspect}`);
  }
  lines.push(`   ${item.target}`);
  return lines.join("\n");
}
