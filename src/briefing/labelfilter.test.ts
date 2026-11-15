/**
 * #312 (doc/design/briefing-focus-controls.md): --label filters the candidate pool with AND
 * semantics before ranking and section budgets, while every fact stays collected, so a
 * nonmatching blocker or claim still counts. Injected facts only; both engines.
 */
import { describe, expect, it } from "vite-plus/test";
import { briefing } from "./briefing.js";
import { compactBriefing, compactText } from "./compact.js";
import { presentBriefing } from "./service.js";
import { argumentsFor } from "../cli.js";
import type { Issue, Snapshot } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

const compact = (
  data: Snapshot,
  options: { role?: string; labels?: string[]; section?: string } = {},
) =>
  compactBriefing(
    data,
    { limit: 10, agent: "me", role: "implementer", ...options },
    briefing(data, { limit: 1000, agent: "me" }, new Date(time)),
  );
const targets = (r: ReturnType<typeof compact>) =>
  r.actions.items.map((url) => Number(url.split("/").pop()));
const blockedBy = (dependant: Issue, blocker: Issue): void => {
  dependant.issueDependenciesSummary!.blockedBy = 1;
  dependant.issueDependenciesSummary!.totalBlockedBy = 1;
  dependant.blockedBy = page([
    {
      number: blocker.number,
      title: blocker.title,
      url: blocker.url,
      state: "OPEN",
      repository: { nameWithOwner: repo },
      issueDependenciesSummary: blocker.issueDependenciesSummary!,
    },
  ]);
};

describe("--label (#312)", () => {
  it("keeps only subjects carrying every label, in the unfiltered order; no labels is unchanged", () => {
    const data = snapshot(
      [
        issue(1, ["status:ready", "sfx", "audio"]),
        issue(2, ["status:ready", "sfx"]),
        issue(3, ["status:ready"]),
        issue(4, ["status:ready", "sfx", "audio"]),
      ],
      [],
    );
    const all = compact(data);
    expect(all).not.toHaveProperty("filter");
    const scoped = compact(data, { labels: ["sfx", "Audio"] });
    expect(targets(all)).toEqual([1, 2, 3, 4]);
    expect(targets(scoped)).toEqual([1, 4]);
    expect(scoped.filter).toMatchObject({
      labels: ["sfx", "Audio"],
      semantics: "all",
      unknownMembership: [],
    });
    expect(scoped.subjects.map((s) => s.number).sort()).toEqual([1, 4]);
  });

  it("a nonmatching blocker still blocks: filtering never makes a blocked ticket eligible", () => {
    const blocked = issue(1, ["status:ready", "sfx"]);
    const blocker = issue(2, ["status:ready"]);
    blockedBy(blocked, blocker);
    const pickup = (r: ReturnType<typeof compact>) =>
      r.role!.sections.find((sec) => sec.name === "pickup")!.items.map((row) => row.url);
    const all = compact(snapshot([blocked, blocker], []));
    expect(pickup(all)).toEqual([blocker.url]);
    // Filtered to the blocked ticket's label: the unlabelled blocker still blocks it.
    const r = compact(snapshot([blocked, blocker], []), { labels: ["sfx"] });
    expect(pickup(r)).toEqual([]);
    // Any next step it keeps is exactly what the unfiltered view says about it.
    expect(targets(r)).toEqual(targets(all).filter((n) => n === 1));
    expect(r.subjects.find((s) => s.number === 1)?.findings).toEqual(
      all.subjects.find((s) => s.number === 1)?.findings,
    );
  });

  it("states the scope and the owned work outside it; an empty result is not an all-clear", () => {
    const data = snapshot([issue(1, ["status:ready", "agent:me"]), issue(2, ["status:ready"])], []);
    const r = compact(data, { labels: ["sfx"] });
    expect(r.filter?.outside).toEqual({ owned: 1, addressed: 0 });
    const text = compactText(r, 10000);
    expect(text).toContain(
      "Filtered view: only subjects carrying every label sfx; not a whole-board view. Outside this filter: 1 owned and 0 addressed obligation(s).",
    );
    expect(text).toContain(
      "No next steps match the label filter (other work may exist outside it).",
    );
    expect(text).not.toContain("No next steps found.");
  });

  it("counts retained delivery responsibility outside the filter, not only claims", () => {
    const submitted = issue(5, []);
    const data = snapshot([submitted, issue(6, ["status:ready", "sfx"])], []);
    const r = compactBriefing(
      data,
      {
        limit: 10,
        agent: "me",
        role: "implementer",
        labels: ["sfx"],
        responsible: new Map([[submitted.url, ["me"]]]),
      },
      briefing(data, { limit: 1000, agent: "me" }, new Date(time)),
    );
    expect(r.filter?.outside.owned).toBe(1);
  });

  it("truncated labels leave membership unknown and the result incomplete, never a known nonmatch", () => {
    const truncated = issue(1, ["status:ready"]);
    truncated.labels = { ...truncated.labels, pageInfo: { hasNextPage: true, endCursor: "c" } };
    const r = compact(snapshot([truncated, issue(2, ["status:ready", "sfx"])], []), {
      labels: ["sfx"],
    });
    expect(r.filter?.unknownMembership).toEqual([truncated.url]);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.warnings.join(" ")).toMatch(
      /whether they match the label filter is unknown/,
    );
  });

  it("matches a PR on its own labels, never its linked issue's", () => {
    const linked = issue(1, ["status:ready", "sfx"]);
    const failing = pr();
    failing.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page([
      { name: "verify", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    const r = compact(snapshot([linked], [failing]), { labels: ["sfx"] });
    expect(r.subjects.some((s) => s.url === failing.url)).toBe(false);
    const labelled = { ...failing, labels: page([{ name: "sfx" }]) };
    const withLabel = compact(snapshot([linked], [labelled]), { labels: ["sfx"] });
    expect(withLabel.subjects.some((s) => s.url === labelled.url)).toBe(true);
  });

  it("composes with --section: filter first, then the whole section", () => {
    const data = snapshot(
      Array.from({ length: 8 }, (_, i) =>
        issue(i + 1, i % 2 ? ["status:ready", "sfx"] : ["status:ready"]),
      ),
      [],
    );
    const r = compact(data, { labels: ["sfx"], section: "pickup" });
    expect(r.focus?.items.map((row) => Number(row.url.split("/").pop()))).toEqual([2, 4, 6, 8]);
  });

  it("filters the default Datalog engine's actions the same way", async () => {
    const data = snapshot(
      [
        issue(1, ["status:ready", "sfx"]),
        issue(2, ["status:ready"]),
        issue(3, ["status:ready", "sfx"]),
      ],
      [],
    );
    const present = (labels?: string[]) =>
      presentBriefing(
        data,
        {
          limit: 10,
          maxChars: 10000,
          role: "implementer",
          agent: "me",
          ...(labels ? { labels } : {}),
        },
        undefined,
        new Date(time),
      );
    const all = (await present()).report as { rankedActions: { items: { target: string }[] } };
    const scoped = (await present(["sfx"])).report as {
      rankedActions: { items: { target: string }[] };
      decisionEngine: { used: string };
    };
    expect(scoped.decisionEngine.used).toBe("datalog");
    expect(scoped.rankedActions.items.map((i) => i.target)).toEqual(
      all.rankedActions.items.map((i) => i.target).filter((t) => !t.endsWith("/2")),
    );
  });

  it("parses repeated --label and refuses contradictory requests", () => {
    expect(argumentsFor(["--label", "sfx", "--label", "audio"]).label).toEqual(["sfx", "audio"]);
    expect(() => argumentsFor(["--label", ""])).toThrow(/nonempty/);
    expect(() => argumentsFor(["--label", "sfx", "--full"])).toThrow(/separate request/);
    expect(() => argumentsFor(["--label", "sfx", "--issue", "3"])).toThrow(/separate request/);
    expect(() => argumentsFor(["--label", "sfx", "--role", "human"])).toThrow(/no --label/);
  });
});
