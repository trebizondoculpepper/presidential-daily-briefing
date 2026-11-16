/**
 * The employing human across surfaces (#664): the CLI briefing and the shared read service (MCP
 * and HTTP) carry the same `human` metadata and text line, independent of the agent selected.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { readBriefing } from "../briefing/service.js";
import type { HumanContext } from "../config/humancontext.js";
import { repo, snapshot } from "../testing/snapshots.js";

const human: HumanContext = {
  state: "current",
  host: "github.com",
  login: "alice",
  source: "gh-login",
  observedAt: "2026-11-16T10:00:00.000Z",
};

async function cli(args: string[]) {
  let out = "";
  const code = await main(
    ["--repo", repo, "--no-update-check", ...args],
    async (text) => void (out += text),
    {
      collect: async () => snapshot(),
      currentRepository: async () => repo,
      briefingHuman: async () => human,
    },
  );
  return { code, out };
}

describe("employing human in briefings (#664)", () => {
  it("is reported in CLI JSON and text, whatever agent is selected", async () => {
    for (const agent of ["agent_one", "agent_two"]) {
      const json = JSON.parse((await cli(["--agent", agent, "--json"])).out);
      expect(json.human).toEqual(human);
    }
    const text = (await cli(["--agent", "agent_one"])).out;
    expect(text.split("\n")[0]).toBe("Working for: alice (github.com, the signed-in gh account)");
  });

  it("is the same through the shared read service used by MCP and HTTP", async () => {
    const read = await readBriefing(
      {
        collect: async () => snapshot(),
        dependencyReport: async () => {
          throw new Error("unused");
        },
        humanContext: async () => human,
        now: () => new Date(),
        env: {},
      } as never,
      { repository: repo, agent: "agent_two", limit: 10, maxChars: 100_000 },
    );
    expect((read as unknown as { report: { human: HumanContext } }).report.human).toEqual(human);
    expect(JSON.parse((await cli(["--agent", "agent_two", "--json"])).out).human).toEqual(
      (read as unknown as { report: { human: HumanContext } }).report.human,
    );
  });

  it("adds nothing when no human was resolved", async () => {
    let out = "";
    await main(["--repo", repo, "--no-update-check", "--json"], async (t) => void (out += t), {
      collect: async () => snapshot(),
      currentRepository: async () => repo,
    });
    expect(JSON.parse(out).human).toBeUndefined();
  });
});
