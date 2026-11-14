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
  inspect: "detail",
  "inspect-assessment": "detail",
};
