/**
 * The employing human (#664): one resolver with visible provenance; never guessed from agent or
 * git identity; last known only through an outage, never for missing credentials; host-scoped.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanCacheFile,
  humanContextText,
  resolveHumanContext,
  serverHumanContext,
  type AuthContextReader,
} from "./humancontext.js";
import { createGhService } from "../github/service/service.js";
import { AuthenticationError } from "../github/github.js";

const at = (iso: string) => () => new Date(iso);
const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "pdb-human-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const signedIn =
  (login: string, host = "github.com"): AuthContextReader =>
  async () => ({ host, login });
const outage: AuthContextReader = async () => {
  throw new Error("connect ETIMEDOUT");
};
const signedOut: AuthContextReader = async () => {
  throw new AuthenticationError("not logged in");
};

describe("employing human resolver (#664)", () => {
  it("is the signed-in gh account, recorded as last known for its host", async () => {
    await withDir(async (cacheDir) => {
      const human = await resolveHumanContext(signedIn("alice"), {
        cacheDir,
        now: at("2026-11-16T10:00:00Z"),
      });
      expect(human).toEqual({
        state: "current",
        host: "github.com",
        login: "alice",
        source: "gh-login",
        observedAt: "2026-11-16T10:00:00.000Z",
      });
      const stored = JSON.parse(readFileSync(join(cacheDir, humanCacheFile), "utf8"));
      expect(stored.hosts["github.com"]).toEqual({
        login: "alice",
        observedAt: "2026-11-16T10:00:00.000Z",
      });
    });
  });

  it("uses the last known login during an outage, saying so, and follows an account switch", async () => {
    await withDir(async (cacheDir) => {
      await resolveHumanContext(signedIn("alice"), { cacheDir, now: at("2026-11-16T10:00:00Z") });
      const during = await resolveHumanContext(outage, { cacheDir });
      expect(during).toMatchObject({
        state: "last-known",
        login: "alice",
        observedAt: "2026-11-16T10:00:00.000Z",
      });
      expect(during.state === "last-known" && during.reason).toContain("did not answer");
      // A different signed-in account is the human from now on; the record follows it.
      const switched = await resolveHumanContext(signedIn("bob"), { cacheDir });
      expect(switched).toMatchObject({ state: "current", login: "bob" });
      expect(await resolveHumanContext(outage, { cacheDir })).toMatchObject({ login: "bob" });
    });
  });

  it("never substitutes an older login for missing credentials", async () => {
    await withDir(async (cacheDir) => {
      await resolveHumanContext(signedIn("alice"), { cacheDir });
      const human = await resolveHumanContext(signedOut, { cacheDir });
      expect(human).toMatchObject({ state: "unresolved", login: null, source: "none" });
      expect(human.state === "unresolved" && human.reason).toContain("not signed in");
    });
  });

  it("is host-scoped: one host's account never answers for another", async () => {
    await withDir(async (cacheDir) => {
      await resolveHumanContext(signedIn("alice"), { cacheDir });
      // gh talks to github.com while the target is another host: not this host's human.
      const other = await resolveHumanContext(signedIn("alice"), {
        cacheDir,
        host: "ghe.example.com",
      });
      expect(other).toMatchObject({ state: "unresolved", host: "ghe.example.com" });
      expect(
        await resolveHumanContext(outage, { cacheDir, host: "ghe.example.com" }),
      ).toMatchObject({ state: "unresolved" });
    });
  });

  it("offline reads make no login read and use only the last known record", async () => {
    await withDir(async (cacheDir) => {
      let calls = 0;
      const counting: AuthContextReader = async () => {
        calls++;
        return { host: "github.com", login: "alice" };
      };
      expect(await resolveHumanContext(counting, { cacheDir, offline: true })).toMatchObject({
        state: "unresolved",
      });
      await resolveHumanContext(counting, { cacheDir });
      expect(await resolveHumanContext(counting, { cacheDir, offline: true })).toMatchObject({
        state: "last-known",
        login: "alice",
      });
      expect(calls).toBe(1);
    });
  });

  it("treats a corrupt record or an invalid login as unknown, never as a person", async () => {
    await withDir(async (cacheDir) => {
      writeFileSync(join(cacheDir, humanCacheFile), "{ not json");
      expect(await resolveHumanContext(outage, { cacheDir })).toMatchObject({
        state: "unresolved",
      });
      expect(
        await resolveHumanContext(async () => ({ host: "github.com", login: "bad login!" }), {
          cacheDir,
        }),
      ).toMatchObject({ state: "unresolved" });
    });
  });

  it("states its provenance in text, and a server has one fixed context", () => {
    const server = serverHumanContext(
      { host: "github.com", login: "alice" },
      new Date("2026-11-16T09:00:00Z"),
    );
    expect(server).toMatchObject({ state: "current", login: "alice" });
    expect(humanContextText(server)).toBe(
      "Working for: alice (github.com, the signed-in gh account)",
    );
    expect(
      humanContextText({
        state: "unresolved",
        host: "github.com",
        login: null,
        source: "none",
        reason: "gh is not signed in to github.com (run gh auth status)",
      }),
    ).toBe(
      "Working for: unknown (github.com: gh is not signed in to github.com (run gh auth status))",
    );
  });

  it("accepts a typed GhService account boundary and distinguishes auth refusal from outage (#909)", async () => {
    await withDir(async (cacheDir) => {
      const okService = createGhService({
        transport: async () => ({ ok: true, stdout: JSON.stringify({ login: "alice" }) }),
      });
      expect(await resolveHumanContext(okService, { cacheDir })).toMatchObject({
        state: "current",
        host: "github.com",
        login: "alice",
      });

      const outageService = createGhService({
        transport: async () => ({
          ok: false,
          kind: "exit",
          exitCode: 1,
          stdout: "",
          stderr: "connection timed out",
        }),
      });
      expect(await resolveHumanContext(outageService, { cacheDir })).toMatchObject({
        state: "last-known",
        login: "alice",
      });

      const unauthService = createGhService({
        transport: async () => ({
          ok: false,
          kind: "exit",
          exitCode: 4,
          stdout: "",
          stderr: "To get started with GitHub CLI, please run: gh auth login",
        }),
      });
      expect(await resolveHumanContext(unauthService, { cacheDir })).toMatchObject({
        state: "unresolved",
        login: null,
      });
    });
  });
});
