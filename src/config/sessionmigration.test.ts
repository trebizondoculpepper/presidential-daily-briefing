/**
 * Recovering automatic session identities into the stable harness default (#1047,
 * doc/design/stable-harness-identity.md), with the real store and lock in a disposable checkout.
 */
import { describe, expect, it } from "vite-plus/test";
import { migrateSessionIdentity, parseIdentityDocument, readIdentityBindings } from "./identity.js";
import { withIdentityFixture as fixture } from "../testing/identity.js";

const digest = (c: string) => c.repeat(64);
const legacy = (c: string, name: string, role = "designer") =>
  `[agents."codex.session_${digest(c)}"]\nname = "${name}"\ntriage_role = "${role}"\n`;
const binding = (k: string, c: string) =>
  `"codex-thread_${digest(k)}" = "codex.session_${digest(c)}"\n`;
const migrate = (f: { root: string; repository: string; fs: never; git: never }) =>
  migrateSessionIdentity({ root: f.root, repository: f.repository }, "codex", "codex-thread", {
    fs: f.fs,
    git: f.git,
  });

describe("session identity recovery (#1047)", () => {
  it("creates the default from agreeing session records, keeps them, and retargets only their bindings", async () =>
    fixture(async (f) => {
      await f.fs.writeText(
        f.file,
        `schemaVersion = 1\n[future]\nkeep = true\n${legacy("a", "example_agent")}${legacy("b", "example_agent")}[agents.other]\nname = "other_agent"\n[agentBindings]\n${binding("1", "a")}${binding("2", "b")}"unrelated" = "other"\n`,
      );
      const result = await migrate(f as never);
      expect(result).toMatchObject({
        state: "migrated",
        retargeted: 2,
        record: { name: "example_agent", triageRole: "designer" },
      });
      const doc = parseIdentityDocument((await f.fs.readText(f.file))!);
      const agents = doc.agents as Record<string, unknown>;
      expect(agents.codex).toEqual({ name: "example_agent", triage_role: "designer" });
      // Legacy evidence and unrelated settings survive; nothing is renamed or deleted.
      expect(Object.keys(agents)).toEqual(
        expect.arrayContaining([
          `codex.session_${digest("a")}`,
          `codex.session_${digest("b")}`,
          "other",
        ]),
      );
      expect(doc.future).toEqual({ keep: true });
      const bindings = await readIdentityBindings(f.root, f.fs);
      expect(bindings.get(`codex-thread_${digest("1")}`)).toBe("codex");
      expect(bindings.get(`codex-thread_${digest("2")}`)).toBe("codex");
      // Unknown binding metadata is preserved untouched (not interpreted as a binding).
      expect((doc.agentBindings as Record<string, unknown>).unrelated).toBe("other");
      // A second run finds the default and writes nothing.
      const before = await f.fs.readText(f.file);
      expect(await migrate(f as never)).toMatchObject({ state: "canonical", obsoleteBindings: 0 });
      expect(await f.fs.readText(f.file)).toBe(before);
    }));

  it("refuses disagreeing records with the candidates and exact commands, writing nothing", async () =>
    fixture(async (f) => {
      const raw = `schemaVersion = 1\n${legacy("a", "first_agent")}${legacy("b", "second_agent", "implementer")}[agentBindings]\n${binding("1", "a")}${binding("2", "b")}`;
      await f.fs.writeText(f.file, raw);
      const error = await migrate(f as never).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "identity-unresolved" });
      const text =
        String((error as Error).message) + " " + String((error as { recovery?: string }).recovery);
      expect(text).toContain(`codex.session_${digest("a")}`);
      expect(text).toContain("pdb config set identity.name");
      expect(text).toContain("--entry codex");
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("keeps an existing default and reports, not rewrites, bindings that still name a session entry", async () =>
    fixture(async (f) => {
      const raw = `schemaVersion = 1\n[agents.codex]\nname = "kept_agent"\ntriage_role = "implementer"\n${legacy("a", "old_agent")}[agentBindings]\n${binding("1", "a")}`;
      await f.fs.writeText(f.file, raw);
      expect(await migrate(f as never)).toMatchObject({
        state: "canonical",
        obsoleteBindings: 1,
        record: { name: "kept_agent" },
      });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("ignores unrecognized keys and entries: nothing is found by name or by any codex.* key", async () =>
    fixture(async (f) => {
      const raw = `schemaVersion = 1\n[agents."codex.reviewer"]\nname = "explicit_agent"\n[agentBindings]\n"manual" = "codex.reviewer"\n`;
      await f.fs.writeText(f.file, raw);
      expect(await migrate(f as never)).toEqual({ state: "none" });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("refuses a default entry without a valid name rather than replacing it", async () =>
    fixture(async (f) => {
      const raw = `schemaVersion = 1\n[agents.codex]\ntriage_role = "designer"\n`;
      await f.fs.writeText(f.file, raw);
      await expect(migrate(f as never)).rejects.toMatchObject({ code: "identity-unresolved" });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("refuses when the agreed name is used by another explicit entry", async () =>
    fixture(async (f) => {
      const raw = `schemaVersion = 1\n${legacy("a", "taken_agent")}[agents.other]\nname = "taken_agent"\n[agentBindings]\n${binding("1", "a")}`;
      await f.fs.writeText(f.file, raw);
      await expect(migrate(f as never)).rejects.toMatchObject({ code: "conflict" });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));
});
