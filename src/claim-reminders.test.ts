import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import type { Runtime } from "./cli.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    output: async (s: string) => {
      stdout.push(s);
    },
    errorOutput: async (s: string) => {
      stderr.push(s);
    },
  };
}

function ownedIssueResponse(owners: string[]) {
  return {
    repository: {
      viewerPermission: "WRITE",
      ownerLabel: { name: "agent:jonas_kowalski" },
      claims: { pageInfo: { hasNextPage: false }, nodes: [] },
      issueOrPullRequest: {
        __typename: "Issue",
        id: "I_1",
        number: 42,
        title: "Test issue",
        url: "https://github.com/o/r/issues/42",
        state: "OPEN",
        assignees: { pageInfo: { hasNextPage: false }, nodes: [] },
        labels: {
          pageInfo: { hasNextPage: false },
          nodes: ["status:ready", ...owners].map((name) => ({ name })),
        },
        blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
        issueDependenciesSummary: { blockedBy: 0 },
        closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
        comments: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    },
  };
}

function baseRuntime(
  io: ReturnType<typeof captureOutput>,
  overrides: Partial<Runtime> = {},
): Runtime {
  return {
    collect: async () => {
      throw new Error("no collect");
    },
    currentRepository: async () => "o/r",
    output: io.output,
    errorOutput: io.errorOutput,
    prepareIdentity: async () => ({
      state: "ready",
      agent: "jonas_kowalski",
      entry: null,
      source: "explicit-agent",
      role: "implementer",
      roleSource: "explicit",
      setup: { state: "existing", notices: [] },
    }),
    ...overrides,
  } as unknown as Runtime;
}

describe("pdb claim action-rule reminders (#1030)", () => {
  it("projects ruleReminders in text and JSON for denied claim without newly-acquired obligations", async () => {
    const io = captureOutput();
    const query = async () => ownedIssueResponse(["agent:other_agent"]);
    const rt = baseRuntime(io, { query } as unknown as Partial<Runtime>);

    const code = await main(
      ["claim", "42", "--repo", "o/r", "--agent", "jonas_kowalski", "--role", "implementer"],
      io.output,
      rt,
    );
    expect(code).toBe(1);
    expect(io.stdout()).toContain("REFUSED OWNED_BY_OTHER");
    expect(io.stdout()).toContain("Rules for this work (denied):");
    expect(io.stdout()).toContain("- D-DENY-CLAIM [denial]:");
    expect(io.stdout()).not.toContain("O-CLAIM-ACCEPTANCE");

    const ioJson = captureOutput();
    const codeJson = await main(
      [
        "claim",
        "42",
        "--repo",
        "o/r",
        "--agent",
        "jonas_kowalski",
        "--role",
        "implementer",
        "--json",
      ],
      ioJson.output,
      baseRuntime(ioJson, { query } as unknown as Partial<Runtime>),
    );
    expect(codeJson).toBe(1);
    const parsed = JSON.parse(ioJson.stdout()) as {
      ok: boolean;
      error: string;
      ruleReminders: {
        schemaVersion: number;
        outcome: string;
        admissionRationale: { id: string }[];
        selectedIds: string[];
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("OWNED_BY_OTHER");
    expect(parsed.ruleReminders.schemaVersion).toBe(1);
    expect(parsed.ruleReminders.outcome).toBe("denied");
    expect(parsed.ruleReminders.admissionRationale.map((i) => i.id)).toEqual(["D-DENY-CLAIM"]);
    expect(parsed.ruleReminders.selectedIds).not.toContain("O-CLAIM-ACCEPTANCE");
  });

  it("preserves claimed exit code and emits a presentation warning if reminder rendering fails", async () => {
    const io = captureOutput();
    let queries = 0;
    let writes = 0;
    const query = async () => {
      queries++;
      return ownedIssueResponse(queries === 1 ? [] : ["agent:jonas_kowalski"]);
    };
    const rt = baseRuntime(io, {
      query,
      ghRun: async () => {
        writes++;
        return "";
      },
      renderClaimReminders: async () => {
        throw new Error("synthetic renderer failure");
      },
    } as unknown as Partial<Runtime>);

    const code = await main(
      [
        "claim",
        "42",
        "--repo",
        "o/r",
        "--agent",
        "jonas_kowalski",
        "--role",
        "implementer",
        "--json",
      ],
      io.output,
      rt,
    );
    expect(code).toBe(0);
    expect(writes).toBeGreaterThan(0);
    const writesAfterClaim = writes;
    expect(queries).toBe(2);
    expect(writes).toBe(writesAfterClaim);
    const parsed = JSON.parse(io.stdout()) as {
      ok: boolean;
      noop: boolean;
      ruleRemindersWarning?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.noop).toBe(false);
    expect(parsed.ruleRemindersWarning).toContain("synthetic renderer failure");
  });

  it("shows claimed reminders with role filtering for designer", async () => {
    const io = captureOutput();
    let queries = 0;
    const query = async () => {
      queries++;
      return ownedIssueResponse(queries === 1 ? [] : ["agent:jonas_kowalski"]);
    };
    const code = await main(
      ["claim", "42", "--repo", "o/r", "--agent", "jonas_kowalski", "--role", "designer"],
      io.output,
      baseRuntime(io, {
        query,
        ghRun: async () => "",
      } as unknown as Partial<Runtime>),
    );
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Rules for this work (claimed):");
    expect(io.stdout()).not.toContain("O-CLAIM-DELIVERABLE");
  });

  it("shows the #1114 early-publication duty within the bounded claim display", async () => {
    const io = captureOutput();
    let queries = 0;
    const query = async () => {
      queries++;
      return ownedIssueResponse(queries === 1 ? [] : ["agent:jonas_kowalski"]);
    };
    const code = await main(
      ["claim", "42", "--repo", "o/r", "--agent", "jonas_kowalski", "--role", "implementer"],
      io.output,
      baseRuntime(io, { query, ghRun: async () => "" } as unknown as Partial<Runtime>),
    );
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Rules for this work (claimed):");
    // The early-publication duty leads the obligations and is present in the bounded display,
    // not merely in an omitted catalog (doc/design/native-action-obligations.md).
    expect(io.stdout()).toContain("- O-CLAIM-PUBLISH-EARLY [procedural-obligation]:");
  });
});
