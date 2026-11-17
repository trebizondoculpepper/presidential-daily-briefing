/** Transport-neutral composition for explicit dashboard runs (#585); no live reads or writes. */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { readTicketDoctor } from "./readservices.js";
import { resolveReviewPolicy } from "../config/review-setting.js";
import { issue, page, repo, snapshot, time } from "../testing/snapshots.js";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";

const config = { cwd: SYNTHETIC_ROOT, fs: emptyFileSystem, git: fakeGit(repo) };
const options = {
  staleHours: 24,
  limit: 30,
  now: new Date(time),
  offline: false,
  impactEnabled: true,
};

describe("shared Ticket Doctor read (#585)", () => {
  it.each(["empty", "findings", "incomplete"])(
    "preserves CLI JSON, text and completeness for %s evidence",
    async (kind) => {
      const source = snapshot(
        kind === "empty" ? [] : [issue(1, ["bug", "status:ready", "status:parked"])],
      );
      if (kind === "incomplete") {
        source.issues[0].labels = page([], true);
        source.warnings.push("Some issue evidence was not read.");
      }
      const read = await readTicketDoctor(
        { ...structuredClone(source), reviewPolicy: await resolveReviewPolicy(repo, config) },
        options,
        {},
      );
      const runtime = {
        collect: async () => structuredClone(source),
        currentRepository: async () => repo,
        now: () => new Date(time),
        guide: config,
        estimation: config,
      };
      for (const json of [true, false]) {
        let output = "";
        const exit = await main(
          ["ticket-doctor", "--repo", repo, ...(json ? ["--json"] : [])],
          async (text) => {
            output += text;
          },
          runtime,
        );
        expect(exit).toBe(read.complete ? 0 : 2);
        if (json) expect(JSON.parse(output)).toEqual(read.report);
        else expect(output).toBe(read.text);
      }
      if (kind === "empty") expect(read.report.scanned).toBe(0);
      if (kind === "findings") expect(read.report.tickets[0].url).toBe(issue(1).url);
      if (kind === "incomplete") expect(read.complete).toBe(false);
    },
  );

  it("emits only observed phases and stops before work when already cancelled", async () => {
    const steps: string[] = [];
    await readTicketDoctor(snapshot([]), options, {
      onStep: (s) => steps.push(`${s.step}:${s.state}`),
    });
    expect(steps).toEqual([
      "delivery:running",
      "delivery:done",
      "closed-scan:skipped",
      "findings:running",
      "findings:done",
    ]);
    steps.length = 0;
    await expect(
      readTicketDoctor(snapshot([]), options, {
        signal: AbortSignal.abort(),
        onStep: (s) => steps.push(s.step),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(steps).toEqual([]);
  });

  it("does not turn cancellation during a real service phase into a completed report", async () => {
    const controller = new AbortController();
    const steps: string[] = [];
    await expect(
      readTicketDoctor(snapshot([]), options, {
        signal: controller.signal,
        onStep: (s) => {
          steps.push(`${s.step}:${s.state}`);
          if (s.step === "delivery") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(steps).toEqual(["delivery:running"]);
  });
});
