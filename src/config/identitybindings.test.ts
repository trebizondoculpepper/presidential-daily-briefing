import { describe, expect, it } from "vite-plus/test";
import {
  parseIdentityDocument,
  readBoundIdentity,
  readIdentityBindings,
  setIdentity,
} from "./identity.js";
import { withIdentityFixture as fixture } from "../testing/identity.js";

describe("coherent identity and active binding persistence (#677)", () => {
  it("concurrent first use converges on one name and winning stored role", async () =>
    fixture(async (f) => {
      const results = await Promise.all([
        f.setup("same-thread", "implementer"),
        f.setup("same-thread", "designer"),
      ]);
      expect(new Set(results.map((r) => r.record.name)).size).toBe(1);
      expect(new Set(results.map((r) => r.record.triageRole)).size).toBe(1);
      expect(results.filter((r) => r.generatedName !== null)).toHaveLength(1);
      const b = f.binding("same-thread");
      expect(await readBoundIdentity(f.root, b.key, f.fs)).toMatchObject({
        entry: b.entry,
        record: { name: results[0]!.record.name },
      });
      expect((await readIdentityBindings(f.root, f.fs)).size).toBe(1);
      expect(await f.fs.readText(f.file)).not.toContain("same-thread");
    }));

  it("separate sessions keep distinct names while preserving unrelated typed data", async () =>
    fixture(async (f) => {
      await f.fs.writeText(
        f.file,
        "schemaVersion = 1\n[future]\nkeep = true\nlarge = 9007199254740993\n",
      );
      const results = await Promise.all([f.setup("thread-a"), f.setup("thread-b")]);
      expect(new Set(results.map((r) => r.record.name)).size).toBe(2);
      expect((await readIdentityBindings(f.root, f.fs)).size).toBe(2);
      const document = parseIdentityDocument((await f.fs.readText(f.file))!);
      expect(document.future).toEqual({ keep: true, large: 9007199254740993n });
    }));

  it("refuses an unbound generic entry without allocating or rewriting it", async () =>
    fixture(async (f) => {
      const raw =
        'schemaVersion = 1\n[agents.codex]\nname = "existing_agent"\ntriage_role = "implementer"\n';
      await f.fs.writeText(f.file, raw);
      await expect(f.setup("new-thread")).rejects.toMatchObject({ code: "identity-unresolved" });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("does not recreate a dangling binding", async () =>
    fixture(async (f) => {
      const b = f.binding("missing-thread");
      const raw = `schemaVersion = 1\n[agentBindings]\n"${b.key}" = "${b.entry}"\n`;
      await f.fs.writeText(f.file, raw);
      await expect(readBoundIdentity(f.root, b.key, f.fs)).rejects.toMatchObject({
        code: "identity-unresolved",
      });
      await expect(f.setup("missing-thread")).rejects.toMatchObject({
        code: "identity-unresolved",
      });
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("guards explicit rebinding against a newer concurrent selection", async () =>
    fixture(async (f) => {
      const first = await f.setup("same-thread");
      const b = f.binding("same-thread");
      const change = (entry: string) =>
        setIdentity(
          { root: f.root, repository: f.repository },
          entry,
          "identity.triage_role",
          "implementer",
          {
            fs: f.fs,
            git: f.git,
            random: f.random,
            requireName: true,
            binding: { key: b.key, expectedEntry: first.record.entry, allowRebind: true },
          },
        );
      const results = await Promise.allSettled([change("codex.first"), change("codex.second")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const winner = results.find((r) => r.status === "fulfilled");
      if (winner?.status !== "fulfilled") throw new Error("expected one winner");
      expect((await readBoundIdentity(f.root, b.key, f.fs))?.entry).toBe(winner.value.record.entry);
    }));
  it("refuses an invalid stored name rather than treating its binding as attribution", async () =>
    fixture(async (f) => {
      const b = f.binding("invalid-name");
      await f.fs.writeText(
        f.file,
        `schemaVersion = 1
[agents."${b.entry}"]
name = "${"x".repeat(101)}"
triage_role = "implementer"
[agentBindings]
"${b.key}" = "${b.entry}"
`,
      );
      await expect(readBoundIdentity(f.root, b.key, f.fs)).rejects.toMatchObject({
        code: "identity-unresolved",
      });
    }));
});
