/**
 * Claim-to-employing-human binding (#690): the record `pdb claim` writes and the trusted reader.
 */
import { describe, expect, it } from "vite-plus/test";
import type { HumanContext } from "../config/humancontext.js";
import {
  claimHumanMarker,
  parseClaimHumanMarker,
  readClaimBinding,
  recordedHuman,
  type ClaimHumanBinding,
} from "./claimbinding.js";
import { claimMarkerFor, type Authority, type Comment } from "./claims.js";

const repo = "example/project";
const claimId = (agent: string, n = 7) =>
  /github-triage:claim:([0-9a-f]{16})/.exec(claimMarkerFor(repo, n, agent))![1]!;
const current: HumanContext = {
  state: "current",
  host: "github.com",
  login: "sal",
  source: "gh-login",
  observedAt: "2026-11-20T10:00:00.000Z",
};
const binding = (agent: string, human: HumanContext = current, n = 7): ClaimHumanBinding => ({
  v: 1,
  repository: repo,
  issue: n,
  agent,
  claim: claimId(agent, n),
  human: recordedHuman(human),
});
/** A claim comment as `pdb claim` posts it, with or without the binding. */
const claimComment = (
  agent: string,
  opts: { at?: string; login?: string; bound?: ClaimHumanBinding | null } = {},
): Comment => ({
  body: `Claimed by \`${agent}\` with \`pdb claim\`.\n\n${claimMarkerFor(repo, 7, agent)}${
    opts.bound === null ? "" : `\n${claimHumanMarker(opts.bound ?? binding(agent))}`
  }`,
  createdAt: opts.at ?? "2026-11-20T10:00:05Z",
  url: "https://github.com/example/project/issues/7#issuecomment-1",
  author: { __typename: "User", login: opts.login ?? "sal" },
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const writers = new Set(["sal", "jed"]);
const trust = async (c: Comment): Promise<Authority> =>
  writers.has(c.author?.login ?? "")
    ? { status: "trusted" }
    : { status: "untrusted", why: `${c.author?.login} lacks write permission` };
const read = (comments: Comment[], agent = "kavya", extra = {}) =>
  readClaimBinding(
    comments,
    {
      repository: repo,
      issue: 7,
      agent,
      claim: claimId(agent),
      since: "2026-11-20T10:00:00Z",
      complete: true,
      ...extra,
    },
    trust,
  );

describe("claim employing-human binding (#690)", () => {
  it("round-trips the marker and rejects anything but the exact v1 shape", () => {
    const b = binding("kavya");
    expect(parseClaimHumanMarker(`x ${claimHumanMarker(b)} y`)).toEqual({ ok: true, binding: b });
    expect(parseClaimHumanMarker("no marker")).toBeNull();
    const bad = (o: unknown) =>
      parseClaimHumanMarker(`<!-- github-triage:claim-human v1 ${JSON.stringify(o)} -->`);
    expect(bad({ ...b, extra: 1 })).toMatchObject({ ok: false });
    expect(bad({ ...b, human: { ...b.human, login: "" } })).toMatchObject({ ok: false });
    expect(bad({ ...b, claim: "nothex" })).toMatchObject({ ok: false });
    expect(parseClaimHumanMarker("<!-- github-triage:claim-human v1 {nope -->")).toMatchObject({
      ok: false,
      why: "binding is not JSON",
    });
  });

  it("binds a trusted claim to its recorded human with provenance and source", async () => {
    expect(await read([claimComment("kavya")])).toMatchObject({
      state: "bound",
      host: "github.com",
      login: "sal",
      provenance: "current",
      source: { author: "sal" },
    });
    const lastKnown: HumanContext = {
      ...current,
      state: "last-known",
      reason: "GitHub did not answer",
    } as HumanContext;
    expect(
      await read([claimComment("kavya", { bound: binding("kavya", lastKnown) })]),
    ).toMatchObject({ state: "bound", provenance: "last-known" });
  });

  it("keeps agents and humans apart, including agents sharing one gh account", async () => {
    const shared = [
      claimComment("kavya"),
      claimComment("dario", { bound: binding("dario", { ...current, login: "jed" }) }),
    ];
    expect(await read(shared, "kavya")).toMatchObject({ state: "bound", login: "sal" });
    expect(await read(shared, "dario")).toMatchObject({ state: "bound", login: "jed" });
    // Shared credentials: both agents' claims are posted by `sal`; each binding is its own.
    const sameAccount = [
      claimComment("kavya"),
      claimComment("dario", {
        login: "sal",
        bound: binding("dario", { ...current, login: "jed" }),
      }),
    ];
    expect(await read(sameAccount, "dario")).toMatchObject({ login: "jed" });
  });

  it("reports legacy, spoofed, copied, unresolved, malformed and unread bindings as unknown", async () => {
    expect(await read([claimComment("kavya", { bound: null })])).toMatchObject({
      state: "unknown",
      reason: "legacy",
    });
    expect(await read([claimComment("kavya", { login: "mallory" })])).toMatchObject({
      reason: "untrusted",
    });
    // A binding copied from another agent's claim does not bind this one.
    expect(await read([claimComment("kavya", { bound: binding("dario") })])).toMatchObject({
      reason: "mismatch",
    });
    const unresolved: HumanContext = {
      state: "unresolved",
      host: "github.com",
      login: null,
      source: "none",
      reason: "gh is not signed in",
    };
    expect(
      await read([claimComment("kavya", { bound: binding("kavya", unresolved) })]),
    ).toMatchObject({ reason: "unresolved", why: expect.stringContaining("gh is not signed in") });
    const malformed = claimComment("kavya", { bound: null });
    malformed.body += "\n<!-- github-triage:claim-human v1 {} -->";
    expect(await read([malformed])).toMatchObject({ reason: "malformed" });
    expect(await read([])).toMatchObject({ reason: "no-claim-comment" });
    expect(await read([], "kavya", { complete: false })).toMatchObject({ reason: "incomplete" });
    // An unknown claim start never widens to every historical acquisition (#1152 review).
    expect(await read([claimComment("kavya")], "kavya", { since: null })).toMatchObject({
      state: "unknown",
      reason: "incomplete",
    });
  });

  it("reads only the current acquisition: an older claim's binding never stands in", async () => {
    const before = claimComment("kavya", { at: "2026-11-19T09:00:00Z" });
    const replaced = claimComment("kavya", { bound: null });
    expect(await read([before, replaced])).toMatchObject({ state: "unknown", reason: "legacy" });
    expect(await read([before])).toMatchObject({ reason: "no-claim-comment" });
    // The newest claim comment of the acquisition is the one that counts.
    const repaired = claimComment("kavya", {
      at: "2026-11-20T11:00:00Z",
      bound: binding("kavya", { ...current, login: "jed" }),
    });
    expect(await read([claimComment("kavya"), repaired])).toMatchObject({ login: "jed" });
  });
});
