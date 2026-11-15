import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { main } from "../cli.js";
import { CONFIG_PATH, type ConfigFileSystem, type GitRunner } from "../config/config.js";
import { complexityGuidance } from "./complexity.js";
import { parseLabelProvenance, provenanceComment } from "./estimate.js";
import type { LabelEstimateProvenance } from "./estimate.js";
import { ticketDoctor } from "../workflow/ticketdoctor.js";
import { issue, snapshot, time } from "../testing/snapshots.js";

describe("bundled complexity guidance (#118)", () => {
  const offline = {
    collect: async (): Promise<never> => {
      throw new Error("guidance must not query GitHub");
    },
    currentRepository: async (): Promise<never> => {
      throw new Error("guidance must not resolve a repository");
    },
    updateCheck: async () => ({ status: "skipped" as const, reason: "" }),
  };
  it("renders text and JSON help from one versioned definition without GitHub", async () => {
    let text = "";
    let json = "";
    expect(await main(["estimate", "--help"], async (t) => void (text = t), offline)).toBe(0);
    expect(
      await main(["estimate", "--help", "--json"], async (t) => void (json = t), offline),
    ).toBe(0);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "complexity-guidance",
      guidanceVersion: complexityGuidance.guidanceVersion,
      sizes: ["XS", "S", "M", "L", "XL", "XXL"],
    });
    expect(parsed.bands.map((b: { size: string }) => b.size)).toEqual(parsed.sizes);
    for (const band of complexityGuidance.bands) expect(text).toContain(band.guidance);
    expect(text).toContain(`version ${complexityGuidance.guidanceVersion}`);
    expect(text).toMatch(/not hours/);
    expect(text).toMatch(/waiting/);
    expect(text).toMatch(/no anchors/);
    expect(text).toContain("--rationale TEXT");
    // Repository-neutral: no ticket/PR numbers from any repository are bundled.
    expect(json).not.toMatch(/#\d+/);
  });
  it("lists estimate in top-level help and validates recording arguments first", async () => {
    let text = "";
    await main(["--help"], async (t) => void (text = t), offline);
    expect(text).toContain("estimate --help");
    expect(text).toContain("estimate N --size S --rationale TEXT");
    await expect(main(["estimate", "12", "M"], async () => {}, offline)).rejects.toThrow("Usage:");
    await expect(main(["estimate", "12", "--size", "M"], async () => {}, offline)).rejects.toThrow(
      "--rationale is required",
    );
    await expect(
      main(["estimate", "12", "--size", "huge", "--rationale", "x"], async () => {}, offline),
    ).rejects.toThrow("--size must be one of");
    await expect(main(["estimate"], async () => {}, offline)).rejects.toThrow("Usage:");
  });
});

describe("estimate N records a size label with provenance (#152)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const sha = "a".repeat(40);
  type Answer = { data: unknown; errors: { type?: string; message?: string }[] };
  type Label = { id: string; name: string };
  function harness(
    options: {
      config?: string | null;
      labels?: string[];
      /** Repository label definitions beyond those on the ticket. */
      repoLabels?: string[];
      comments?: string[];
      truncated?: boolean;
      queryErrors?: Answer["errors"];
      /** Change the ticket after the Nth issue read (a concurrent writer). */
      concurrent?: { afterQuery: number; labels?: string[]; comment?: string };
      /** A concurrent writer adds this label just after our label is applied. */
      afterAdd?: string;
      failPage?: number;
      createFails?: "denied" | "race";
      failAdd?: boolean;
      /** Fail removal of this label name, the first N times. */
      failRemove?: { name: string; times: number };
      failComment?: boolean;
      /** Comment bodies written by an untrusted author (#269). */
      untrusted?: string[];
      /** Comment bodies whose author's permission cannot be verified (#269). */
      unverified?: string[];
    } = {},
  ) {
    const files = new Map<string, string>();
    if (options.config) files.set(path, options.config);
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async () => {
        throw new Error("estimate must not write config");
      },
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse"
        ? args[1] === "HEAD"
          ? `${sha}\n`
          : `${root}\n`
        : "origin\thttps://github.com/owner/name.git (fetch)\n";
    let ids = 0;
    const definitions = new Map<string, Label>();
    const define = (name: string): Label => {
      const known = definitions.get(name.toLowerCase());
      if (known) return known;
      const created = { id: `LA_${(ids += 1)}`, name };
      definitions.set(name.toLowerCase(), created);
      return created;
    };
    for (const name of options.repoLabels ?? []) define(name);
    const remote = {
      labels: (options.labels ?? ["bug"]).map(define),
      comments: [...(options.comments ?? [])],
    };
    const names = () => remote.labels.map((l) => l.name);
    const mutations: { query: string; vars: Record<string, string> }[] = [];
    let queries = 0;
    let pageQueries = 0;
    let removeFailures = 0;
    const page = (end: number) => {
      const start = Math.max(0, end - 100);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        // Every comment is by a trusted writer unless the test says otherwise (#269).
        nodes: remote.comments.slice(start, end).map((body) => ({
          body,
          author: {
            __typename: "User",
            login: options.untrusted?.includes(body)
              ? "bot"
              : options.unverified?.includes(body)
                ? "ghost"
                : "writer",
          },
          lastEditedAt: null,
          includesCreatedEdit: false,
          editor: null,
        })),
      };
    };
    const answer = (label: string): Answer => ({
      data: {
        repository: {
          id: "R_1",
          label: definitions.get(label.toLowerCase()) ?? null,
          issue: {
            id: "I_7",
            state: "OPEN",
            labels: { pageInfo: { hasNextPage: !!options.truncated }, nodes: [...remote.labels] },
            comments: page(remote.comments.length),
          },
        },
      },
      errors: options.queryErrors ?? [],
    });
    const ok = (data: unknown): Answer => ({ data, errors: [] });
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["estimate", "7", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        now: () => new Date("2026-11-13T12:00:00Z"),
        estimate: {
          fs,
          git,
          cwd: root,
          trust: () => async (c) =>
            c.author?.login === "writer"
              ? { status: "trusted" }
              : c.author?.login === "ghost"
                ? { status: "unknown", why: "permission could not be verified" }
                : { status: "untrusted", why: `author ${c.author?.login} lacks write permission` },
          api: {
            query: async (query, vars) => {
              if (query.includes("$before")) {
                pageQueries += 1;
                if (options.failPage === pageQueries)
                  return { data: null, errors: [{ type: "INTERNAL", message: "timeout" }] };
                return ok({ repository: { issue: { comments: page(Number(vars.before)) } } });
              }
              queries += 1;
              const a = answer(vars.label!);
              const c = options.concurrent;
              if (c && queries === c.afterQuery) {
                if (c.labels) remote.labels = c.labels.map(define);
                if (c.comment) remote.comments.push(c.comment);
              }
              return a;
            },
            mutate: async (query, vars) => {
              mutations.push({ query, vars });
              if (query.includes("createLabel")) {
                if (options.createFails === "denied")
                  return { data: null, errors: [{ type: "FORBIDDEN", message: "no write" }] };
                const label = define(vars.name!);
                if (options.createFails === "race")
                  return { data: null, errors: [{ message: "Name has already been taken" }] };
                return ok({ createLabel: { label } });
              }
              if (query.includes("addLabelsToLabelable")) {
                if (options.failAdd)
                  return { data: null, errors: [{ type: "FORBIDDEN", message: "no" }] };
                const label = [...definitions.values()].find((l) => l.id === vars.label)!;
                remote.labels.push(label);
                if (options.afterAdd) remote.labels.push(define(options.afterAdd));
                return ok({ addLabelsToLabelable: { clientMutationId: null } });
              }
              if (query.includes("removeLabelsFromLabelable")) {
                const label = remote.labels.find((l) => l.id === vars.label)!;
                const f = options.failRemove;
                if (f && f.name === label.name && removeFailures < f.times) {
                  removeFailures += 1;
                  return { data: null, errors: [{ message: "server error" }] };
                }
                remote.labels = remote.labels.filter((l) => l.id !== vars.label);
                return ok({ removeLabelsFromLabelable: { clientMutationId: null } });
              }
              if (options.failComment) throw new Error("network down");
              remote.comments.push(vars.body!);
              return ok({ addComment: { commentEdge: { node: { url: "https://c/1" } } } });
            },
          },
        },
      });
    const kinds = () =>
      mutations.map(
        (m) =>
          m.query.match(
            /(createLabel|addLabelsToLabelable|removeLabelsFromLabelable|addComment)/,
          )![1],
      );
    return {
      remote,
      names,
      mutations,
      kinds,
      call,
      queries: () => queries,
      pageQueries: () => pageQueries,
      json: () => JSON.parse(out.at(-1)!),
    };
  }
  const harnessMarker = (size: "L" | "M") =>
    provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size,
      previous: [],
      rationale: "someone else's estimate",
      assumptions: [],
      references: [],
      estimator: "ana",
      revision: null,
      guidanceVersion: 1,
      recordedAt: "2026-11-13T11:00:00.000Z",
    });
  const base = ["--size", "M", "--rationale", "few modules; bounded tests", "--json"];

  it("creates only the missing requested label, applies it and records v2 provenance", async () => {
    const t = harness({ labels: ["bug", "status:ready"] });
    expect(
      await t.call(
        ...base,
        "--assumption",
        "blocker #3 supplies the API; waiting excluded",
        "--reference",
        "#86",
      ),
    ).toBe(0);
    expect(t.json()).toMatchObject({
      schemaVersion: 2,
      kind: "complexity-estimate",
      status: "recorded",
      label: "complexity:M",
      previous: [],
      labelCreated: true,
      labelsAdded: ["complexity:M"],
      labelsRemoved: [],
      final: { sizes: ["M"] },
      provenanceWritten: true,
      provenance: {
        storage: "labels",
        size: "M",
        previous: [],
        estimator: null,
        revision: sha,
        guidanceVersion: complexityGuidance.guidanceVersion,
        assumptions: ["blocker #3 supplies the API; waiting excluded"],
        references: ["#86"],
      },
    });
    expect(t.json().provenance).not.toHaveProperty("fieldId");
    expect(t.names()).toEqual(["bug", "status:ready", "complexity:M"]);
    expect(t.kinds()).toEqual(["createLabel", "addLabelsToLabelable", "addComment"]);
    expect(t.mutations[0]!.vars).toMatchObject({ name: "complexity:M", repository: "R_1" });
    // Never touches fields, claims, dependencies or label definitions beyond the one creation.
    expect(
      t.mutations.some((m) => /IssueField|updateLabel|BlockedBy|clearLabels/.test(m.query)),
    ).toBe(false);
    expect(parseLabelProvenance(t.remote.comments[0]!)).toMatchObject({
      size: "M",
      rationale: "few modules; bounded tests",
    });
  });
  it("reuses an existing case-equivalent label definition without restyling it", async () => {
    const t = harness({ repoLabels: ["Complexity:m"] });
    expect(await t.call(...base, "--agent", "kavya")).toBe(0);
    expect(t.json()).toMatchObject({ labelCreated: false, labelsAdded: ["Complexity:m"] });
    expect(t.json().provenance.estimator).toBe("kavya");
    expect(t.kinds()).toEqual(["addLabelsToLabelable", "addComment"]);
  });
  it("replaces a different estimate with only a justification of the new size", async () => {
    const t = harness({ labels: ["bug", "complexity:S", "agent:ana"] });
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({
      status: "recorded",
      previous: ["S"],
      labelsRemoved: ["complexity:S"],
      provenance: { previous: ["S"] },
    });
    expect(t.names()).toEqual(["bug", "agent:ana", "complexity:M"]);
    expect(t.remote.comments[0]).toContain("(was S)");
  });
  it("replaces a conflicting set and records every observed previous size", async () => {
    const t = harness({ labels: ["complexity:XL", "bug", "complexity:s"] });
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({ previous: ["S", "XL"], final: { sizes: ["M"] } });
    expect(t.names()).toEqual(["bug", "complexity:M"]);
  });
  it("does not duplicate or talk over an assessment finished concurrently before the final read", async () => {
    const record = (rationale: string) =>
      provenanceComment({
        schemaVersion: 2,
        kind: "complexity-estimate",
        storage: "labels",
        size: "M",
        previous: ["S"],
        rationale,
        assumptions: [],
        references: [],
        estimator: null,
        revision: null,
        guidanceVersion: 1,
        recordedAt: "2026-11-13T00:00:00.000Z",
      });
    // The matching record appears on the third issue read (the final verification read).
    const same = harness({
      labels: ["complexity:S"],
      concurrent: { afterQuery: 2, comment: record("few modules; bounded tests") },
    });
    expect(await same.call(...base)).toBe(0);
    expect(same.json()).toMatchObject({ status: "unchanged", provenanceWritten: false });
    expect(same.remote.comments).toHaveLength(1);
    const other = harness({
      labels: ["complexity:S"],
      concurrent: { afterQuery: 2, comment: record("someone else's reasoning") },
    });
    expect(await other.call(...base)).toBe(2);
    expect(other.json()).toMatchObject({ status: "conflict", provenanceWritten: false });
    expect(other.remote.comments).toHaveLength(1);
  });
  it("records only observed sizes when older provenance disagrees with the current label", async () => {
    // The label was changed by hand from S to M after an S estimate was recorded.
    const t = harness({ labels: ["complexity:M"] });
    t.remote.comments.push(
      provenanceComment({
        schemaVersion: 2,
        kind: "complexity-estimate",
        storage: "labels",
        size: "S",
        previous: [],
        rationale: "older",
        assumptions: [],
        references: [],
        estimator: null,
        revision: null,
        guidanceVersion: 1,
        recordedAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({ previous: ["M"], provenance: { previous: ["M"] } });
    expect(parseLabelProvenance(t.remote.comments.at(-1)!)?.previous).toEqual(["M"]);
  });
  it("tells a partial-write retry to pass --replace so the replaced size is recorded", async () => {
    const t = harness({ labels: ["complexity:S"], failComment: true });
    expect(await t.call(...base)).toBe(2);
    expect(t.json().recovery).toContain("--replace S");
  });
  it("is idempotent and reports the stored provenance, not a fresh timestamp", async () => {
    const t = harness({ labels: ["complexity:M"] });
    const stored = provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size: "M",
      previous: [],
      rationale: "few modules; bounded tests",
      assumptions: [],
      references: [],
      estimator: null,
      revision: "b".repeat(40),
      guidanceVersion: 1,
      recordedAt: "2026-11-01T00:00:00.000Z",
    });
    t.remote.comments.push(stored);
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({
      status: "unchanged",
      provenance: { recordedAt: "2026-11-01T00:00:00.000Z", revision: "b".repeat(40) },
    });
    expect(t.mutations).toEqual([]);
  });
  describe("complexity provenance authority (#269)", () => {
    const stored = provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size: "M",
      previous: [],
      rationale: "few modules; bounded tests",
      assumptions: [],
      references: [],
      estimator: null,
      revision: "b".repeat(40),
      guidanceVersion: 1,
      recordedAt: "2026-11-01T00:00:00.000Z",
    });
    it("a spoofed identical record by an untrusted author is not a retry receipt: the caller's assessment is recorded", async () => {
      const t = harness({ labels: ["complexity:M"], comments: [stored], untrusted: [stored] });
      expect(await t.call(...base)).toBe(0);
      expect(t.json()).toMatchObject({ status: "recorded" });
      expect(t.json().provenance.recordedAt).not.toBe("2026-11-01T00:00:00.000Z");
      expect(t.kinds()).toEqual(["addComment"]);
      expect(t.remote.comments[0]).toBe(stored); // never edited or deleted
    });
    it("an identical record of unknown authority is not a receipt either, even with an older trusted one behind it", async () => {
      const older = stored.replace("2026-11-01", "2026-10-01");
      const t = harness({
        labels: ["complexity:M"],
        comments: [older, stored],
        unverified: [stored],
      });
      expect(await t.call(...base)).toBe(0);
      expect(t.json().status).toBe("recorded");
      expect(t.remote.comments).toHaveLength(3);
    });
    it("an identical trusted record behind an untrusted newer one is still the retry receipt", async () => {
      const spoof = stored.replace("few modules", "spoofed");
      const t = harness({
        labels: ["complexity:M"],
        comments: [stored, spoof],
        untrusted: [spoof],
      });
      expect(await t.call(...base)).toBe(0);
      expect(t.json()).toMatchObject({ status: "unchanged" });
      expect(t.mutations).toEqual([]);
    });
  });
  it("records a new same-size assessment as provenance only", async () => {
    const t = harness();
    await t.call(...base);
    const writes = t.mutations.length;
    expect(await t.call("--size", "M", "--rationale", "scope grew: new API", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ status: "recorded", labelsAdded: [], labelsRemoved: [] });
    expect(t.kinds().slice(writes)).toEqual(["addComment"]);
    expect(t.remote.comments).toHaveLength(2);
  });
  it("treats --replace as an optional guard, refusing only when it is stale", async () => {
    const t = harness({ labels: ["complexity:L"] });
    expect(await t.call(...base, "--replace", "S")).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "stale" });
    expect(t.mutations).toEqual([]);
    expect(await t.call(...base, "--replace", "L")).toBe(0);
    expect(t.names()).toEqual(["complexity:M"]);
  });
  it("refuses truncated or errored label reads as unknown and writes nothing", async () => {
    const truncated = harness({ truncated: true });
    expect(await truncated.call(...base)).toBe(2);
    expect(truncated.json()).toMatchObject({
      status: "failed:unknown",
      code: "labels-unavailable",
    });
    const errored = harness({ queryErrors: [{ type: "INTERNAL", message: "timeout" }] });
    expect(await errored.call(...base)).toBe(2);
    expect(errored.json().code).toBe("labels-unavailable");
    expect([...truncated.mutations, ...errored.mutations]).toEqual([]);
  });
  it("refuses unrecognized complexity labels instead of guessing, naming --replace-invalid", async () => {
    const t = harness({ labels: ["complexity:huge"] });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ code: "unrecognized-label" });
    expect(t.json().recovery).toContain("--replace-invalid");
    expect(t.json().recovery).toContain("--remove-label");
    expect(t.mutations).toEqual([]);
  });
  it("--replace-invalid removes invalid and other size labels and records them (#178)", async () => {
    const t = harness({
      labels: ["bug", "complexity:huge", "complexity:S", "Complexity:Big"],
      repoLabels: ["complexity:M"],
    });
    expect(await t.call(...base, "--replace-invalid")).toBe(0);
    expect(t.names()).toEqual(["bug", "complexity:M"]);
    expect(t.json()).toMatchObject({
      status: "recorded",
      previous: ["S"],
      replacedInvalid: ["complexity:huge", "Complexity:Big"],
      labelsRemoved: ["complexity:huge", "complexity:S", "Complexity:Big"],
      final: { sizes: ["M"], invalid: [] },
    });
    const stored = parseLabelProvenance(t.remote.comments.at(-1)!);
    expect(stored).toMatchObject({
      previous: ["S"],
      replacedInvalid: ["complexity:huge", "Complexity:Big"],
    });
    expect(t.remote.comments.at(-1)).toContain(
      "Replaced invalid complexity label(s): complexity:huge",
    );
    // Idempotent: the same command again writes nothing.
    const writes = t.mutations.length;
    expect(await t.call(...base, "--replace-invalid")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.mutations).toHaveLength(writes);
  });
  it("--replace-invalid still removes an invalid label beside an already-recorded size", async () => {
    const t = harness({ labels: ["complexity:M"] });
    expect(await t.call(...base)).toBe(0);
    t.remote.labels.push({ id: "LA_99", name: "complexity:medium" });
    expect(await t.call(...base)).toBe(1);
    expect(await t.call(...base, "--replace-invalid")).toBe(0);
    expect(t.names()).toEqual(["complexity:M"]);
    expect(t.json()).toMatchObject({ status: "recorded", replacedInvalid: ["complexity:medium"] });
  });
  it("--replace-invalid retries a partial write without duplicating, recording only observed labels", async () => {
    const options = {
      labels: ["complexity:huge"],
      repoLabels: ["complexity:M"],
      failComment: true,
    };
    const t = harness(options);
    expect(await t.call(...base, "--replace-invalid")).toBe(2);
    expect(t.json()).toMatchObject({ status: "partial", provenanceWritten: false });
    expect(t.json().recovery).toContain("Re-run the same command");
    expect(t.names()).toEqual(["complexity:M"]);
    options.failComment = false;
    expect(await t.call(...base, "--replace-invalid")).toBe(0);
    expect(t.json()).toMatchObject({ status: "recorded", labelsAdded: [], labelsRemoved: [] });
    // The invalid label was removed by the earlier run, so this run did not observe it.
    expect(parseLabelProvenance(t.remote.comments.at(-1)!)?.replacedInvalid).toBeUndefined();
    expect(await t.call(...base, "--replace-invalid")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.remote.comments).toHaveLength(1);
  });
  it("--replace-invalid treats truncated labels as unknown and writes nothing", async () => {
    const t = harness({ labels: ["complexity:huge"], truncated: true });
    expect(await t.call(...base, "--replace-invalid")).toBe(2);
    expect(t.json()).toMatchObject({ status: "failed:unknown", code: "labels-unavailable" });
    expect(t.mutations).toEqual([]);
  });
  it("Ticket Doctor's invalid-label command runs through the real estimate parser (#178)", async () => {
    const r = ticketDoctor(
      {
        ...snapshot([issue(7, ["bug", "status:ready", "complexity:huge"])], []),
        repository: "owner/name",
      },
      { now: new Date(time) },
    );
    const finding = r.tickets[0]!.findings.find((f) => f.kind === "complexity-label-invalid")!;
    const fix = finding.plan.steps.find((x) => x.argv[1] === "estimate")!;
    expect(fix.command).not.toContain("#");
    expect(fix.argv.slice(fix.argv.indexOf("--repo"), fix.argv.indexOf("--repo") + 2)).toEqual([
      "--repo",
      "owner/name",
    ]);
    expect(fix.placeholders).toEqual(["<SIZE>", "<RATIONALE>"]);
    const argv = fix.argv
      .slice(3)
      .map((a) => (a === "<SIZE>" ? "XL" : a === "<RATIONALE>" ? "huge meant XL" : a));
    const t = harness({ labels: ["bug", "complexity:huge"] });
    expect(await t.call(...argv, "--json")).toBe(0);
    expect(t.names()).toEqual(["bug", "complexity:XL"]);
  });
  it("reports permission refusal to create the label without touching the ticket", async () => {
    const t = harness({ labels: ["complexity:S"], createFails: "denied" });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "failed", code: "label-create-denied" });
    expect(t.json().message).toContain("FORBIDDEN");
    expect(t.kinds()).toEqual(["createLabel"]);
    expect(t.names()).toEqual(["complexity:S"]);
  });
  it("settles a label-creation race by fresh verification", async () => {
    const t = harness({ createFails: "race" });
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({ status: "recorded", labelCreated: false });
    expect(t.names()).toEqual(["bug", "complexity:M"]);
  });
  it("refuses when the ticket changes between the first read and the write", async () => {
    const t = harness({
      labels: ["complexity:S"],
      repoLabels: ["complexity:M"],
      concurrent: { afterQuery: 1, labels: ["complexity:L"] },
    });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "concurrent-change" });
    expect(t.json().message).toContain("changed from S to L");
    expect(t.mutations).toEqual([]);
    const marker = harness({
      repoLabels: ["complexity:M"],
      concurrent: { afterQuery: 1, comment: harnessMarker("L") },
    });
    expect(await marker.call(...base)).toBe(1);
    expect(marker.json().code).toBe("concurrent-change");
  });
  it("reports a concurrent contradictory size after writing as a conflict, not success", async () => {
    const t = harness({ afterAdd: "complexity:XL" });
    expect(await t.call(...base)).toBe(2);
    expect(t.json()).toMatchObject({
      status: "conflict",
      provenanceWritten: false,
      final: { sizes: ["M", "XL"] },
    });
    expect(t.remote.comments).toEqual([]);
  });
  it("reports a partial label write honestly and completes it on retry", async () => {
    const t = harness({
      labels: ["complexity:S", "complexity:L"],
      failRemove: { name: "complexity:L", times: 1 },
    });
    expect(await t.call(...base)).toBe(2);
    expect(t.json()).toMatchObject({
      status: "partial",
      labelsRemoved: ["complexity:S"],
      provenanceWritten: false,
    });
    expect(t.json().recovery).toContain("re-run the same command");
    expect(t.names()).toEqual(["complexity:L", "complexity:M"]);
    expect(await t.call(...base)).toBe(0);
    expect(t.json()).toMatchObject({ status: "recorded", previous: ["M", "L"] });
    expect(t.names()).toEqual(["complexity:M"]);
    expect(t.remote.comments).toHaveLength(1);
  });
  it("reports a failed comment as partial and adds only provenance on retry", async () => {
    const t = harness({ labels: ["complexity:S"], failComment: true });
    expect(await t.call(...base)).toBe(2);
    expect(t.json()).toMatchObject({ status: "partial", provenanceWritten: false });
    expect(t.names()).toEqual(["complexity:M"]);
    const retry = harness({ labels: ["complexity:M"] });
    expect(await retry.call(...base, "--replace", "S")).toBe(0);
    expect(retry.json()).toMatchObject({ status: "recorded", provenance: { previous: ["S"] } });
    expect(retry.kinds()).toEqual(["addComment"]);
  });
  it("pages back through older comments for provenance; failed paging is unknown", async () => {
    const t = harness({ labels: ["complexity:M"] });
    await t.call(...base);
    for (let i = 0; i < 150; i += 1) t.remote.comments.push(`chatter ${i}`);
    const writes = t.mutations.length;
    expect(await t.call(...base)).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.pageQueries()).toBe(1);
    expect(t.mutations.length).toBe(writes);
    const failing = harness({
      comments: Array.from({ length: 150 }, (_, i) => `chatter ${i}`),
      failPage: 1,
    });
    expect(await failing.call(...base)).toBe(2);
    expect(failing.json().code).toBe("provenance-unavailable");
    expect(failing.mutations).toEqual([]);
  });
  it("gives opt-in guidance when disabled, without remote calls", async () => {
    const t = harness({ config: '{"schemaVersion":1,"complexity":{"enabled":false}}\n' });
    expect(await t.call(...base)).toBe(2);
    expect(t.json()).toMatchObject({ status: "disabled" });
    expect(t.queries()).toBe(0);
  });
  it("keeps the provenance marker safe inside an HTML comment and ignores forgeries", () => {
    const p: LabelEstimateProvenance = {
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size: "S",
      previous: ["M"],
      rationale: "ends --> early? <b>",
      assumptions: [],
      references: [],
      estimator: null,
      revision: null,
      guidanceVersion: 1,
      recordedAt: "2026-11-13T12:00:00.000Z",
    };
    const body = provenanceComment(p);
    expect(body.split("-->")[0]).toContain("recordedAt");
    expect(parseLabelProvenance(body)).toEqual(p);
    expect(
      parseLabelProvenance('<!-- github-triage:complexity-estimate v2 {"size":"HUGE"} -->'),
    ).toBeNull();
    // Field-era (v1) records are not label provenance.
    expect(
      parseLabelProvenance(
        '<!-- github-triage:complexity-estimate v1 {"kind":"complexity-estimate","fieldId":"F","size":"S","rationale":"x"} -->',
      ),
    ).toBeNull();
  });
});
