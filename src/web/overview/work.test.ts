/** Overview current work (#825): parsing the existing team view, supplied states only. */
import { describe, expect, it } from "vite-plus/test";
import { claimStatus, parseWorkResponse, workLoader, type WorkState } from "./work.js";

const url = (n: number) => `https://github.com/example/project/issues/${n}`;
const team = (agents: unknown[], extra: Record<string, unknown> = {}) => ({
  status: "complete",
  warnings: ["envelope"],
  result: {
    kind: "team-view",
    fetchedAt: "2026-11-20T10:00:00Z",
    freshness: { fetchedAt: "2026-11-20T10:00:00Z" },
    presence: "unknown: no presence source",
    agents,
    completeness: { complete: false, warnings: ["labels incomplete"] },
    ...extra,
  },
});

describe("overview current work (#825)", () => {
  it("keeps claims with their supplied activity and PRs, and continuing responsibilities", () => {
    const r = parseWorkResponse(
      team([
        {
          agent: "kavya",
          presence: "unknown",
          claims: [
            {
              number: 1,
              title: "One",
              url: url(1),
              activity: { state: "waiting", reason: "question on #1" },
              latestActivity: { at: "2026-11-20T09:00:00Z", source: "comment" },
              pullRequests: [
                {
                  number: 9,
                  url: "https://github.com/example/project/pull/9",
                  draft: false,
                  ready: false,
                  blockers: ["checks failing"],
                },
              ],
            },
            {
              number: 2,
              title: "Two",
              url: url(2),
              activity: null,
              latestActivity: null,
              pullRequests: [],
            },
          ],
          responsibilities: [
            {
              number: 3,
              url: url(3),
              scope: "deliverable",
              deliverable: "example/project#10",
              followUp: "actionable",
            },
          ],
        },
      ]),
    )!;
    const a = r.agents[0]!;
    expect(a.claims.map(claimStatus)).toEqual(["waiting: question on #1", "activity not read"]);
    expect(a.claims[0]!.pullRequests[0]).toMatchObject({ number: 9, blockers: ["checks failing"] });
    expect(a.responsibilities[0]).toMatchObject({ number: 3, followUp: "actionable" });
    expect(r.warnings).toEqual(["labels incomplete", "envelope"]);
    expect(r.presence).toMatch(/^unknown/);
  });

  it("rejects anything that is not a team view", () => {
    expect(parseWorkResponse({ result: { kind: "pipeline-metrics" } })).toBeNull();
    expect(parseWorkResponse(team([{ agent: 1 }]))).toBeNull();
  });

  it("reads the team API for the project, discards superseded reads, and refreshes past the cache", async () => {
    const pending: { url: string; resolve: (b: unknown) => void }[] = [];
    const fetcher = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) =>
        pending.push({
          url: String(input),
          resolve: (b) => resolve(new Response(JSON.stringify(b), { status: 200 })),
        }),
      )) as typeof fetch;
    const states: WorkState[] = [];
    const loader = workLoader("/api/v1/team", fetcher, (s) => void states.push(s));
    const first = loader.load("example/project");
    const second = loader.load("example/other");
    expect(pending[0]!.url).toBe("/api/v1/team?repo=example%2Fproject");
    pending[1]!.resolve(team([]));
    await second;
    pending[0]!.resolve(team([{ agent: "x", claims: [] }]));
    expect(await first).toBeNull();
    expect(states.at(-1)).toMatchObject({ status: "ready", response: { agents: [] } });
    void loader.refresh();
    expect(pending[2]!.url).toBe("/api/v1/team?repo=example%2Fother&refresh=true");
  });
});
