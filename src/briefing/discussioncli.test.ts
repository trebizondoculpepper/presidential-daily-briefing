/** `pdb discussion` (#1100): injected GraphQL and identity boundaries only; no live GitHub. */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import type { Query } from "../github/github.js";
import type { EffectiveIdentity } from "../config/effectiveidentity.js";

const repo = "o/r";
const node = (number: number, comments: number | null, state = "OPEN") => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state,
  ...(comments === null ? {} : { comments: { totalCount: comments } }),
});
const absent = {
  state: "unresolved",
  agent: null,
  entry: null,
  source: "unresolved",
  role: null,
  roleSource: "unknown",
  setup: { state: "none", changed: false, persisted: false, notices: [] },
  diagnostic: { code: "identity-absent", message: "no identity", recovery: "none" },
} as unknown as EffectiveIdentity;

function runtimeFor(nodes: unknown[], more = false) {
  const states: string[] = [];
  const intents: string[] = [];
  const query: Query = async (source) => {
    states.push(/states:(\[[^\]]*\])/.exec(source)?.[1] ?? "");
    return {
      repository: {
        issues: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? "1" : null } },
      },
    } as never;
  };
  return {
    states,
    intents,
    runtime: {
      currentRepository: async () => repo,
      query,
      now: () => new Date("2026-11-19T12:00:00Z"),
      prepareIdentity: async (options: { intent: string }) => {
        intents.push(options.intent);
        return absent;
      },
    },
  };
}
const run = async (args: string[], r: ReturnType<typeof runtimeFor>) => {
  let out = "";
  const code = await main(
    ["discussion", ...args, "--no-update-check"],
    async (t) => void (out += t),
    r.runtime as never,
  );
  return { code, out };
};

describe("pdb discussion (#1100)", () => {
  it("prints the native ranking with counts, links, scope and the proxy explanation", async () => {
    const r = runtimeFor([node(1, 3), node(2, 9), node(3, 0)]);
    const { code, out } = await run(["--repo", repo], r);
    expect(code).toBe(0);
    expect(out).toContain(
      `Discussion view: ${repo} (open issues; fetched 2026-11-19T12:00:00.000Z)`,
    );
    expect(out.indexOf("#2 Ticket 2 (9 comments)")).toBeLessThan(
      out.indexOf("#1 Ticket 1 (3 comments)"),
    );
    expect(out).toContain(`https://github.com/${repo}/issues/2`);
    expect(out).toContain("does not imply disagreement");
    expect(out).not.toContain("#3 Ticket 3");
    // Observational read: identity is prepared read-only and never minted.
    expect(r.intents).toEqual(["readonly"]);
  });

  it("emits JSON with the shared result, bounded display and omissions", async () => {
    const r = runtimeFor([node(1, 3), node(2, 9), node(4, 1)]);
    const { code, out } = await run(["--repo", repo, "--json", "--limit", "2"], r);
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json).toMatchObject({ kind: "discussion-view", scope: "open", shown: 2, omitted: 1 });
    expect(json.items.map((i: { number: number }) => i.number)).toEqual([2, 1]);
  });

  it("supports closed history and all states, and reports partial coverage with exit 2", async () => {
    const closed = runtimeFor([node(8, 20, "CLOSED")]);
    expect((await run(["--repo", repo, "--state", "closed"], closed)).out).toContain(
      "(20 comments, closed)",
    );
    expect(closed.states).toEqual(["[CLOSED]"]);
    const partial = runtimeFor([node(1, 2), node(5, null)]);
    const { code, out } = await run(["--repo", repo, "--state", "all"], partial);
    expect(partial.states).toEqual(["[OPEN, CLOSED]"]);
    expect(code).toBe(2);
    expect(out).toContain("Unknown comment count, not ranked: #5");
    expect(out).toContain("INCOMPLETE:");
  });

  it("validates its arguments and documents itself", async () => {
    for (const bad of [
      ["--state", "maybe"],
      ["--limit", "0"],
      ["--limit", "x"],
      ["--repo", "bad"],
    ])
      await expect(run(bad, runtimeFor([]))).rejects.toThrow();
    const { out } = await run(["--help"], runtimeFor([]));
    expect(out).toContain("Usage: pdb discussion");
    expect(out).toContain("neither a blocker nor proof of disagreement");
  });
});
