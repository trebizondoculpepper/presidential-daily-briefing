/**
 * Command text for engine-selected action kinds. This is rendering, not policy: the engine
 * returns a rule's kind and the host turns it into a command (doc/design/rules-component.md).
 * It moves into the host adapter when the engine boundary is split.
 */
export const commandTemplates: Record<string, string> = {
  detail: "pdb --repo {repo} --issue {number} --json",
  pr: "pdb pr {number} --repo {repo}",
  claim: "pdb claim {number} --repo {repo} --agent {agent}{platformFlag}",
  release: "pdb release {other} --repo {repo} --agent {agent} --as incomplete --note TEXT",
  complexity:
    "pdb estimate {number} --metric complexity --size SIZE --rationale TEXT --repo {repo}",
  impact: "pdb estimate {number} --metric impact --size SIZE --rationale TEXT --repo {repo}",
  // #1067: the Ticket Doctor fix for invalid metric labels (#178), chosen by the adapter.
  "complexity-replace":
    "pdb estimate {number} --metric complexity --size SIZE --rationale TEXT --replace-invalid --repo {repo}",
  "impact-replace":
    "pdb estimate {number} --metric impact --size SIZE --rationale TEXT --replace-invalid --repo {repo}",
  // #413: an explicit resume; the read-only team inventory for reviewing several claims.
  resume: "pdb claim resume {number} --repo {repo} --agent {agent}",
  team: "pdb team --repo {repo}",
};
export const commandKinds: Record<string, string> = {
  "estimate-complexity": "complexity",
  "assess-impact": "impact",
  "pr-follow-up": "pr",
  "design-review": "pr",
  "addressed-response": "detail",
  decide: "detail",
  document: "detail",
  "continue-implementation": "detail",
  design: "detail",
  // #1092: refinement is read on the ticket until the refinement commands land (#1095, #1096).
  refine: "detail",
  inspect: "detail",
  "inspect-assessment": "detail",
  "answer-questions": "detail",
  "orphaned-question": "detail",
  "sign-off": "pr",
  "resume-claim": "resume",
  "review-owned-work": "team",
  "inspect-ownership": "team",
  // A wait is followed with a focused read, never a claim, merge or resubmit (#413).
  "wait-claim": "detail",
  "unassign-allow": "detail",
  "unassign-noop": "detail",
  "unassign-refuse-context": "detail",
  "unassign-refuse-permission-denied": "detail",
  "unassign-refuse-permission-unknown": "detail",
  "unassign-refuse-evidence": "detail",
};
