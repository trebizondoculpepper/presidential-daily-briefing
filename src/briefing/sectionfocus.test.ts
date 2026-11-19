/**
 * #311 (doc/design/briefing-focus-controls.md): `--section ID` shows one registered section of
 * the role view with its fixed row cap lifted; capped sections name that exact request; the
 * byte budget still applies; defaults are unchanged. Injected facts only.
 */
import { describe, expect, it } from "vite-plus/test";
import { briefing } from "./briefing.js";
import { BriefingArgumentError, compactBriefing, compactText } from "./compact.js";
import { presentBriefing } from "./service.js";
import { argumentsFor } from "../cli.js";
import type { Snapshot } from "../github/types.js";
import { issue, repo, snapshot, time } from "../testing/snapshots.js";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";

const compact = (data: Snapshot, options: { limit: number; role?: string; section?: string }) =>
  compactBriefing(
    data,
    { agent: "me", ...options },
    briefing(data, { limit: 1000 }, new Date(time)),
  );
const eight = () =>
  snapshot(
    Array.from({ length: 8 }, (_, i) => issue(i + 1)),
    [],
  );

describe("--section (#311)", () => {
  it("lifts one section's row cap through its own selector; the default view is unchanged", () => {
    const plain = compact(eight(), { limit: 10, role: "implementer" });
    const pickup = plain.role!.sections.find((s) => s.name === "pickup")!;
    expect(pickup).toMatchObject({ total: 8, omitted: 3 });
    expect(plain).not.toHaveProperty("focus");
    const focused = compact(eight(), { limit: 10, role: "implementer", section: "pickup" });
    expect(focused.focus).toMatchObject({
      role: "implementer",
      section: "pickup",
      total: 8,
      shown: 8,
      omitted: 0,
    });
    // Same rows and order as the capped section, only longer.
    expect(focused.focus!.items.slice(0, 5)).toEqual(pickup.items);
    // --limit stays the next-steps limit.
    expect(focused.actions.items.length).toBeLessThanOrEqual(10);
  });

  it("names the exact request for a capped section; byte truncation is stated as such", () => {
    const context = compactText(compact(eight(), { limit: 10, role: "implementer" }), 100000, {
      context: true,
    });
    expect(context).toContain("PICKUP (8; 3 omitted)");
    expect(context).toContain("  3 more: pdb --role implementer --section pickup");
    const text = compactText(
      compact(eight(), { limit: 10, role: "implementer", section: "pickup" }),
      100000,
    );
    expect(text).toMatch(/^\S+ — implementer section pickup \(fetched /);
    expect(text).toContain("PICKUP (8)");
    expect(text).not.toContain("NEXT STEPS");
    const cut = compactText(
      compact(eight(), { limit: 10, role: "implementer", section: "pickup" }),
      700,
    );
    expect(cut).toContain(
      "Truncated due to maximum size; raise --max-chars or use --json for every row.",
    );
    expect(cut.length).toBeLessThanOrEqual(800);
  });

  it("covers designer sections and other-context", () => {
    const design = snapshot(
      Array.from({ length: 7 }, (_, i) => issue(i + 1, ["status:needs-design"])),
      [],
    );
    const r = compact(design, { limit: 10, role: "designer", section: "design-pickup" });
    expect(r.focus).toMatchObject({ section: "design-pickup", total: 7, omitted: 0 });
    const other = compact(eight(), { limit: 10, role: "designer", section: "other-context" });
    expect(other.focus).toMatchObject({ section: "other-context", background: true });
    expect(other.focus!.total).toBe(other.focus!.items.length);
  });

  it("an empty section is empty only within complete evidence", () => {
    const empty = compact(eight(), { limit: 10, role: "implementer", section: "stale-claims" });
    expect(compactText(empty, 10000)).toContain("No rows in section stale-claims.");
    const incomplete = {
      ...empty,
      completeness: { ...empty.completeness, complete: false, warnings: ["labels truncated"] },
    };
    expect(compactText(incomplete, 10000)).toContain(
      "No rows observed in section stale-claims, but evidence is incomplete: this does not mean none exist.",
    );
  });

  it("rejects an unknown ID, a missing role and the human role with the supported choices", () => {
    expect(() => compact(eight(), { limit: 10, role: "implementer", section: "nope" })).toThrow(
      new BriefingArgumentError(
        "--section for role implementer must be one of: addressed, pr-follow-up, own-work, pr-waiting, pickup, pickup-inspect, unblock-candidates, stale-claims, pending-design, other-context.",
      ),
    );
    expect(() => compact(eight(), { limit: 10, section: "pickup" })).toThrow(/needs a role view/);
    // An explicitly empty ID is rejected with the choices, never read as "no section".
    expect(() => compact(eight(), { limit: 10, role: "designer", section: "" })).toThrow(
      /--section for role designer must be one of: addressed, decision-needed/,
    );
    expect(() => argumentsFor(["--role", "implementer", "--section", ""])).toThrow(
      /must be one of/,
    );
    expect(() => argumentsFor(["--role", "designer", "--section", "pickup"])).toThrow(
      /design-pickup/,
    );
    expect(() => argumentsFor(["--role", "human", "--section", "pickup"])).toThrow(/no sections/);
    expect(() => argumentsFor(["--section", "pickup", "--full"])).toThrow(/separate request/);
    expect(() => argumentsFor(["--section", "pickup", "--issue", "3"])).toThrow(/separate request/);
    expect(argumentsFor(["--section", "pickup"]).section).toBe("pickup");
  });

  it("works under the default Datalog engine, including its OTHER CONTEXT", async () => {
    const present = (section?: string) =>
      presentBriefing(
        eight(),
        {
          limit: 2,
          maxChars: 100000,
          role: "implementer",
          agent: "me",
          ...(section ? { section } : {}),
        },
        undefined,
        new Date(time),
      );
    const plain = await present();
    expect(plain.report.decisionEngine).toMatchObject({ used: "datalog" });
    const other = (
      plain.report as { role: { sections: { name: string; total: number; omitted: number }[] } }
    ).role.sections.find((s) => s.name === "other-context")!;
    const focused = (await present("other-context")).report as {
      focus: { total: number; shown: number };
    };
    expect(focused.focus).toMatchObject({ total: other.total, shown: other.total });
    const pickup = (await present("pickup")).report as {
      focus: { section: string; total: number };
    };
    expect(pickup.focus).toMatchObject({ section: "pickup", total: 8 });
  });

  it("projects a section from the native ranking, never a second TypeScript ranking (#1088)", async () => {
    // #1 is unfavorable (impact XS, complexity XL) and older; #3 is an easy win (impact L,
    // complexity S). The native policy ranks #3 first; the TypeScript pickup order is oldest-first.
    // #2 is restricted to another platform, so the native policy denies its pickup for this viewer.
    const data = snapshot(
      [
        issue(1, ["status:ready", "impact:XS", "complexity:XL"]),
        issue(2, ["status:ready", "platform:codex"]),
        issue(3, ["status:ready", "impact:L", "complexity:S"]),
      ],
      [],
    );
    const present = (section?: string) =>
      presentBriefing(
        data,
        {
          limit: 10,
          maxChars: 100000,
          role: "implementer",
          agent: "me",
          platform: "claude-code",
          ...(section ? { section } : {}),
        },
        { cwd: SYNTHETIC_ROOT, git: fakeGit(repo), fs: emptyFileSystem },
        new Date(time),
      );
    const plain = (await present()).report as {
      rankedActions: { items: { kind: string; target: string }[] };
    };
    const nativePickup = plain.rankedActions.items
      .filter((i) => i.kind === "implement")
      .map((i) => i.target);
    expect(nativePickup.some((t) => t.endsWith("/2"))).toBe(false);
    expect(nativePickup.findIndex((t) => t.endsWith("/3"))).toBeLessThan(
      nativePickup.findIndex((t) => t.endsWith("/1")),
    );
    const focused = (await present("pickup")).report as {
      focus: { items: { url: string }[]; total: number };
    };
    expect(focused.focus.items.map((r) => r.url)).toEqual(nativePickup);
    expect(focused.focus.total).toBe(nativePickup.length);
    // A section with no single native kind is refused, not re-ranked.
    await expect(present("stale-claims")).rejects.toThrow(BriefingArgumentError);
    // Declared background context sections stay available on the native view.
    for (const section of ["pr-waiting", "pickup-inspect", "pending-design"])
      expect(
        ((await present(section)).report as { focus: { section: string } }).focus.section,
      ).toBe(section);
  });
});
