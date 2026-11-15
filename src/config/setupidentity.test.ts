/**
 * `pdb setup identity` (#314): the one documented way for a new agent to obtain its own
 * identity. Injected filesystem and Git; local only.
 */
import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { main } from "../cli.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { IDENTITY_FILE, parseIdentityDocument } from "./identity.js";

const root = "/repo";
const file = join(root, IDENTITY_FILE);
const exclude = join(root, ".git/info/exclude");
const existing = `[agents.claude]
name = "kept_agent"
triage_role = "implementer"
token = "s3cret-token"

[agents.codex]
name = "codex_agent"
triage_role = "designer"
`;

function setup(initial?: string, env: Record<string, string> = { CLAUDECODE: "1" }) {
  const files = new Map<string, string>(initial === undefined ? [] : [[file, initial]]);
  const fs: ConfigFileSystem = {
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, text) => void files.set(path, text),
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    appendText: async (path, text) => void files.set(path, (files.get(path) ?? "") + text),
    remove: async (path) => void files.delete(path),
    makeDirectory: async () => undefined,
  };
  const fail = (code: number) => Object.assign(new Error(`exit ${code}`), { code });
  const git: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
    if (args[0] === "rev-parse" && args[1] === "--git-path") return ".git/info/exclude\n";
    if (args[0] === "remote") return "origin\thttps://github.com/owner/name.git (fetch)\n";
    if (args[0] === "ls-files") throw fail(1);
    if (args[0] === "check-ignore") {
      const rules = (files.get(exclude) ?? "").split("\n");
      const name = args.at(-1)!;
      const rule = name.endsWith(".tmp") ? `/${IDENTITY_FILE}.*.tmp` : `/${name}`;
      if (rules.includes(rule)) return "";
      throw fail(1);
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  let seed = 0;
  const random = () => ((seed = (seed * 7 + 3) % 11) + 0.5) / 11;
  const out: string[] = [];
  const call = (...args: string[]) =>
    main(["setup", ...args, "--no-update-check"], async (t) => void out.push(t), {
      collect: async () => {
        throw new Error("no GitHub");
      },
      currentRepository: async () => {
        throw new Error("no GitHub");
      },
      config: { fs, git, cwd: `${root}/nested`, random, env },
    });
  const agents = () =>
    parseIdentityDocument(files.get(file) ?? "").agents as Record<string, Record<string, string>>;
  return { files, out, call, agents, json: () => JSON.parse(out.at(-1)!) };
}

describe("pdb setup identity (#314)", () => {
  it("creates this harness's entry with a generated name once, and says which --agent to use", async () => {
    const t = setup();
    expect(await t.call("identity", "--role", "implementer", "--json")).toBe(0);
    const result = t.json();
    expect(result).toMatchObject({
      kind: "setup-identity",
      entry: "claude",
      selection: "environment",
      nameSource: "generated",
      triageRole: "implementer",
      changed: true,
      createdEntry: true,
      excludeRuleAdded: true,
    });
    const name = result.name as string;
    expect(t.agents().claude).toEqual({ name, triage_role: "implementer" });
    expect(result.next).toEqual([
      `pdb --agent ${name} --role implementer`,
      `pdb claim N --agent ${name}`,
    ]);
    // A rerun keeps the name and reports it.
    expect(await t.call("identity", "--role", "implementer")).toBe(0);
    expect(t.out.at(-1)).toContain(`Already set up identity ${name} (existing name, kept)`);
    expect(t.agents().claude!.name).toBe(name);
  });

  it("keeps an existing name when the role changes, and never echoes other values", async () => {
    const t = setup(existing);
    expect(await t.call("identity", "--role", "designer")).toBe(0);
    expect(t.out.at(-1)).toContain(
      "Set up identity kept_agent (existing name, kept) for entry claude",
    );
    expect(t.out.at(-1)).toContain("triage role designer (was implementer)");
    expect(t.out.join("")).not.toContain("s3cret-token");
    expect(t.agents().claude).toMatchObject({ name: "kept_agent", triage_role: "designer" });
    expect(t.agents().codex).toMatchObject({ name: "codex_agent" });
  });

  it("an Ori session without an entry is told its own key, never another harness's", async () => {
    const t = setup(existing, { ORI_SESSION_ID: "s" });
    expect(await t.call("identity", "--role", "implementer", "--json")).toBe(1);
    expect(t.json()).toMatchObject({
      code: "identity-unresolved",
      message: expect.stringMatching(/^No entry exists for the ori harness/),
      recovery:
        "Create this agent's own entry (SERVER: this ori server's name):\npdb setup identity --role implementer --entry ori.SERVER",
    });
    expect(t.files.get(file)).toBe(existing);
    // With its own key it gets its own generated name; the claude and codex entries are untouched.
    expect(
      await t.call("identity", "--role", "implementer", "--entry", "ori.agent-inbox", "--json"),
    ).toBe(0);
    const name = t.json().name as string;
    expect(name).not.toMatch(/^(kept_agent|codex_agent)$/);
    expect(t.agents()["ori.agent-inbox"]).toEqual({ name, triage_role: "implementer" });
    expect(t.agents().claude!.name).toBe("kept_agent");
  });

  it("a dry run writes nothing and shows the entry and the name it would use", async () => {
    const fresh = setup();
    expect(await fresh.call("identity", "--role", "designer", "--dry-run")).toBe(0);
    expect(fresh.files.size).toBe(0);
    expect(fresh.out.at(-1)).toMatch(
      /^Dry run, nothing written: would set up identity a newly generated, locally unique name .* for entry claude/,
    );
    const known = setup(existing);
    expect(await known.call("identity", "--role", "implementer", "--dry-run", "--json")).toBe(0);
    expect(known.json()).toMatchObject({ dryRun: true, name: "kept_agent", changed: false });
    expect(known.files.get(file)).toBe(existing);
  });

  it("refuses an existing entry without a valid name before writing anything", async () => {
    const nameless = `[agents.claude]\ntriage_role = "designer"\nnote = "keep"\n`;
    const t = setup(nameless);
    expect(await t.call("identity", "--role", "implementer", "--json")).toBe(1);
    expect(t.json()).toMatchObject({
      code: "invalid-value",
      message: expect.stringMatching(/has no valid name.*nothing was changed/),
      recovery: "Set one explicitly: pdb config set identity.name NAME --entry claude",
    });
    expect(t.files.get(file)).toBe(nameless);
    // The dry run refuses the same way instead of promising a generated name.
    expect(await t.call("identity", "--role", "implementer", "--dry-run", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "invalid-value" });
    expect(t.files.get(file)).toBe(nameless);
  });

  it("never overwrites a malformed identity file", async () => {
    const broken = "[agents\nbroken";
    const t = setup(broken);
    expect(await t.call("identity", "--role", "implementer", "--json")).toBe(1);
    expect(t.json().kind).toBe("config-error");
    expect(t.files.get(file)).toBe(broken);
  });

  it("requires a valid role and one selector", async () => {
    const t = setup();
    for (const args of [
      ["identity"],
      ["identity", "--role", "owner"],
      ["identity", "--role", "implementer", "--entry", "claude", "--harness", "claude"],
      ["name", "--role", "implementer"],
    ]) {
      expect(await t.call(...args, "--json"), args.join(" ")).toBe(1);
      expect(t.json()).toMatchObject({ code: "usage" });
    }
    expect(t.files.size).toBe(0);
  });
});
