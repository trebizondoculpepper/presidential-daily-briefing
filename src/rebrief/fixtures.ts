/** Synthetic rebrief inputs and fresh reads shared by the rebrief tests. Test-only. */
import type { Input, Read } from "./core.js";

export const now = Date.parse("2026-11-15T10:00:00Z");
export const input: Input = {
  repository: "o/r",
  agent: "agent",
  role: "implementer",
  platform: "codex",
  session: "private-session",
  eventId: "private-event",
  enabled: true,
  reason: "natural",
};
export const read = (): Read => ({
  selection: { repository: "o/r", agent: "agent", role: "implementer", platform: "codex" },
  fresh: true,
  text: "Original policy reason and next command",
  report: {
    schemaVersion: 2,
    repository: "o/r",
    freshness: {
      offline: false,
      startedAt: new Date(now).toISOString(),
      fetchedAt: new Date(now).toISOString(),
    },
    completeness: { complete: true, warnings: [] },
    ranking: { platform: "codex" },
    role: {
      name: "implementer",
      sections: [
        { items: [{ url: "https://github.com/o/r/issues/1", reason: "Original policy reason" }] },
      ],
    },
    decisionEngine: { used: "datalog", policyVersion: "1", rulesHash: "rules1" },
    rankedActions: {
      policyVersion: 1,
      total: 1,
      omitted: 0,
      items: [
        {
          id: "action1",
          kind: "implement",
          target: "https://github.com/o/r/issues/1",
          role: "implementer",
          band: 6,
          complexity: { state: "current", size: "S" },
          impact: { state: "current", size: "M" },
          unlocks: 0,
          unlocksUnknown: [],
          reasonCodes: ["ordinary"],
          evidence: ["evidence"],
          nextCommand: "pdb claim 1 --agent agent --repo o/r",
          thenCommand: null,
          inspection: null,
        },
      ],
    },
    subjects: [
      {
        url: "https://github.com/o/r/issues/1",
        labels: ["status:ready"],
        owners: [],
        pullRequest: { head: "head1", checks: [], unresolvedThreads: 0, linkedIssues: [] },
      },
    ],
  },
});
