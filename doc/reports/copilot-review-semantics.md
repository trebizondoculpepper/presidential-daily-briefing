# Copilot code review: change-request and merge-block semantics (#678)

Researched 2026-11-16 against current primary GitHub documentation and the repository's
review-provider model (`origin/main`). This is bounded research for #678; it feeds #694/#695
(codex-or-copilot review evidence) rather than implementing policy. It does not change branch
protection, auto-merge, workflows or real review state, and it does not turn Copilot into a
label-writing agent.

## Conclusion

GitHub Copilot code review **cannot formally request changes** and therefore provides **no
GitHub-enforced merge block through review state**. Its reviews are always submitted with the
`COMMENTED` review state; the review decision is never `CHANGES_REQUESTED` and never
`APPROVED` by default. PDB's "action required" verdict for Copilot must therefore come from the
findings Copilot reports (inline comments and its verdict line in the overview comment), not
from the review's decision field.

The optional documentation setting that lets a Copilot review carry an `APPROVED` state is a
separate configuration; even there, Copilot review comments and the resulting state are the only
lever, and the setting's caveats (below) mean a single-user/org owner should plumb the declared
policy explicitly rather than infer approval from a `COMMENTED` review.

## Provider identity

GitHub reports Copilot code review under the bot account `copilot-pull-request-reviewer` and the
GitHub App of the same slug. `src/workflow/reviewpolicy.ts` already models exactly that:

```ts
copilot: {
  id: "copilot",
  label: "Copilot",
  accounts: ["copilot-pull-request-reviewer"],
  apps: ["copilot-pull-request-reviewer"],
  quota: /usage limits?\b|rate[- ]limit(?:ed| exceeded)?/i,
},
```

A user account that merely names itself `copilot-pull-request-reviewer` is not the integration:
the provider model already requires GitHub to report the author as a Bot, consistent with the
other adapters.

## Review state and verdict semantics

### GitHub review states

- `COMMENTED`: the default review state Copilot uses. It never blocks a merge on its own; a
  repository can merge a PR with only `COMMENTED` reviews unless other rules require approval.
- `APPROVED`: Copilot can be configured to leave an approving review (see the optional setting
  below). An approved review satisfies branch-protection "require approvals" only when it comes
  from an account the ruleset counts.
- `CHANGES_REQUESTED`: **Copilot never emits this state.** GitHub's own documentation describes
  Copilot leaving a "Comment review" by default and explicitly contrasts "Request changes"
  (which Copilot-generated reviews do not use); independent evidence reviews of public
  repositories show only `COMMENTED` (or optionally `APPROVED`) states from
  `copilot-pull-request-reviewer`.

### Copilot's "Changes recommended" is verdict text, not enforcement

Copilot's overview comment can say "Changes recommended" and its per-file comments flag issues,
but this is presentation in a comment thread. It does not set `CHANGES_REQUESTED`, does not
affect the PR's mergeability state, and does not itself populate branch-protection gates. It is
the raw material PDB should read into findings.

## Optional approval setting and its limits

GitHub documents a Copilot setting that, when enabled, makes a Copilot review leave an
`APPROVED` review **in addition to** comments. Known caveats:

- It is configured per account/organization, not per PR; enabling it is a real change to how
  Copilot reviews behave for that account.
- Configuration is two separate switches (enterprise/organization/repository levels, default
  off): "Allow Copilot to approve pull requests" (Copilot may submit an approving review) and
  "Allow Copilot approvals to count toward merge requirements" (that review satisfies required
  approvals). An optional repository file-path list (one glob per line, up to 15) makes an
  approval count only when every changed file matches; blank means all files.
- An approving Copilot review counts toward "required approvals" only when the ruleset explicitly
  includes the `copilot-pull-request-reviewer` account; a blanket "require approvals" rule may
  not count it.
- Reviewers can dismiss the approval; a dismissal is an explicit, observable event and must be
  honored (stale acceptance is not current).
- The setting does **not** give Copilot a request-changes state or a block; at most it lets
  Copilot satisfy the _approval_ side of a gate.

## GitHub enforcement vs PDB's computed action-required state

The distinction the ticket asks for:

- **GitHub enforcement** is what the platform itself gates on: `CHANGES_REQUESTED` or a
  required-approval ruleset. Copilot cannot produce the former and only optionally contributes
  to the latter.
- **PDB's computed action-required state** is the triage tool's verdict that a PR needs the
  human/agent to act. For Copilot this must be derived from findings: unresolved threads Copilot
  opened, its verdict text, and any configured `APPROVED` (current at head). PDB must not claim
  Copilot "requested changes" when GitHub never recorded that state, and must not treat a
  `COMMENTED` review as approval.

This is consistent with the merged #695/#739 `codex-or-copilot` policy: coverage is satisfied
by an accepted Codex or Copilot current-head review, findings from either provider still block,
and a quota/error/skipped/stale provider result never satisfies coverage.

## Recommended smallest approach

1. Keep the `copilot-pull-request-reviewer` identity and `COMMENTED`-as-findings interpretation.
   Read Copilot review threads and the verdict line; a substantive unresolved finding from
   Copilot blocks, exactly as it does for Codex/CodeRabbit.
2. Do not implement a Copilot "request changes" path — the platform does not expose one.
3. For the optional `APPROVED` setting: surface it as a declared configuration choice, and when
   enabled, treat a current-head `APPROVED` review from the bot account as provider acceptance
   only if the repository's declared policy names `copilot-pull-request-reviewer` as a counted
   approver. Never infer acceptance from `COMMENTED`.
4. Feed these verified semantics into #694/#695 instead of duplicating collection in this
   ticket.

## Evidence

- GitHub documentation: "Copilot code review" (comparing comment/approve behavior and the
  account that leaves reviews), accessed 2026-11-16.
- Repository provider model: `src/workflow/reviewpolicy.ts` (accounts/apps/quota for `copilot`).
- The merged codex-or-copilot policy delivery (#695/#739) and its native scenarios under
  `src/rules/datalog/scenarios/review-policy.edn`.
- This report contains no live mutation and no branch-protection/auto-merge/workflow change.
