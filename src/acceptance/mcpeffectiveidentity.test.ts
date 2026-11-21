import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  createServer,
  prepareMcpIdentity,
  type McpRuntime,
  type McpOptions,
} from "../mcp/server.js";
import { boundedEnvelope, budgetBytes, resultBytes } from "../mcp/bounded.js";
import type { ServerEffectiveIdentity } from "../config/serveridentity.js";
import type { HumanContext } from "../config/humancontext.js";
import { withIdentityFixture as fixture, type IdentityFixture } from "../testing/identity.js";
import { snapshot, clock, issue } from "../testing/snapshots.js";

const human: HumanContext = {
  state: "current",
  host: "github.com",
  login: "owner",
  source: "gh-login",
  observedAt: "2026-11-17T00:00:00.000Z",
};
const environment = { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "mcp-private-thread" };
const setup = async (
  f: IdentityFixture,
  patch: Partial<McpRuntime> = {},
  options: Partial<McpOptions> = {},
  clientName = "fixture",
) => {
  const selected = { project: f.root, repo: f.repository, role: "implementer", ...options };
  const runtime: McpRuntime = {
    currentRepository: async () => f.repository,
    collect: async () => snapshot([], []),
    dependencyReport: async () => {
      throw new Error("unused dependency reader");
    },
    now: clock,
    engineClock: () => 0,
    guide: { cwd: f.root, fs: f.fs, git: f.git },
    estimation: { cwd: f.root, fs: f.fs, git: f.git },
    fs: f.fs,
    git: f.git,
    env: environment,
    humanContext: async () => human,
    ...patch,
  };
  const stderr: string[] = [];
  await prepareMcpIdentity(
    selected,
    runtime,
    {
      env: runtime.env ?? {},
      fs: f.fs,
      git: f.git,
      random: f.random,
      human: async () => ({ context: human, authenticationFailed: false }),
    },
    (text) => {
      stderr.push(text);
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(selected, runtime);
  await server.connect(serverSide);
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(clientSide);
  return { client, runtime, stderr };
};
const identityOf = (result: { structuredContent?: unknown }) => {
  const document = boundedEnvelope.parse(result.structuredContent);
  return {
    document,
    effective: document.data?.effectiveIdentity as ServerEffectiveIdentity | undefined,
  };
};

describe("effective identity in actual MCP responses (#677)", () => {
  it("carries startup creation as history while later calls only report reuse", async () =>
    fixture(async (f) => {
      const { client, runtime, stderr } = await setup(f);
      try {
        const raw = await f.fs.readText(f.file);
        for (let i = 0; i < 2; i++) {
          const result = await client.callTool({ name: "triage_briefing", arguments: {} });
          const { document, effective } = identityOf(result);
          expect(document.selection.agent).toBe(runtime.identitySession!.startup.agent);
          expect(effective).toMatchObject({
            agent: document.selection.agent,
            human,
            setup: { state: "reused", notices: [] },
            startup: {
              phase: "local-server-startup",
              result: { setup: { state: "created", persisted: true } },
            },
          });
          expect(effective?.startup.result.setup.notices.join(" ")).toContain(
            "created agent identity",
          );
          expect(resultBytes(result)).toBeLessThanOrEqual(budgetBytes);
          expect(JSON.stringify(result)).not.toContain(environment.CODEX_THREAD_ID);
        }
        expect(stderr.join("").match(/created agent identity/g)).toHaveLength(1);
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await client.close();
      }
    }));

  it("keeps an arbitrary tool agent as display focus instead of replacing local execution context", async () =>
    fixture(async (f) => {
      const { client, runtime } = await setup(f);
      try {
        const raw = await f.fs.readText(f.file);
        const { document, effective } = identityOf(
          await client.callTool({ name: "triage_briefing", arguments: { agent: "another_agent" } }),
        );
        expect(document.selection).toMatchObject({
          agent: "another_agent",
          identitySource: "tool",
        });
        expect(effective?.agent).toBe(runtime.identitySession!.startup.agent);
        expect(effective?.agent).not.toBe("another_agent");
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await client.close();
      }
    }));

  it("a role in a read request cannot bootstrap a missing startup identity", async () =>
    fixture(async (f) => {
      const { client } = await setup(f, {}, { role: undefined });
      try {
        const { effective } = identityOf(
          await client.callTool({
            name: "triage_briefing",
            arguments: { role: "implementer", agent: "display_agent" },
          }),
        );
        expect(effective).toMatchObject({
          state: "unresolved",
          agent: null,
          startup: { result: { state: "unresolved" } },
        });
        expect(await readdir(f.root)).toEqual([]);
      } finally {
        await client.close();
      }
    }));

  it("retains the verified startup outcome when the original collection fails", async () =>
    fixture(async (f) => {
      const { client } = await setup(f, {
        collect: async () => {
          throw new Error("private subprocess diagnostic");
        },
      });
      try {
        const result = await client.callTool({ name: "triage_briefing", arguments: {} });
        const { document, effective } = identityOf(result);
        expect(document.status).toBe("error");
        expect(document.error?.code).toBe("collection-failed");
        expect(effective).toMatchObject({
          setup: { state: "reused" },
          startup: { result: { setup: { state: "created", persisted: true } } },
        });
        expect(JSON.stringify(result)).not.toContain("private subprocess diagnostic");
        expect(resultBytes(result)).toBeLessThanOrEqual(budgetBytes);
      } finally {
        await client.close();
      }
    }));

  it("preserves identity and startup notices through whole-result pruning", async () =>
    fixture(async (f) => {
      const tickets = Array.from({ length: 40 }, (_, i) => ({
        ...issue(i + 1),
        title: `Ticket ${i}: ${"long title ".repeat(100)}`,
      }));
      const { client } = await setup(f, { collect: async () => snapshot(tickets, []) });
      try {
        const result = await client.callTool({
          name: "triage_briefing",
          arguments: { limit: 40, maxChars: 40000 },
        });
        const { document, effective } = identityOf(result);
        expect(document.status).not.toBe("error");
        expect(effective?.startup.result.setup.notices.join(" ")).toContain(
          "created agent identity",
        );
        expect(effective?.setup).toMatchObject({ state: "reused", notices: [] });
        expect(
          document.presentation.truncatedFields.some((path) =>
            path.startsWith("effectiveIdentity"),
          ),
        ).toBe(false);
        expect(
          Object.values(document.presentation.omitted).some((count) => count > 0) ||
            document.presentation.truncatedFields.length > 0,
        ).toBe(true);
        expect(resultBytes(result)).toBeLessThanOrEqual(budgetBytes);
        expect(document.presentation.bytes).toBe(resultBytes(result));
      } finally {
        await client.close();
      }
    }));
  it("retains the human attention view beside effective execution context", async () =>
    fixture(async (f) => {
      const { client, runtime } = await setup(f);
      try {
        const { document, effective } = identityOf(
          await client.callTool({
            name: "triage_briefing",
            arguments: { role: "human", agent: "owner" },
          }),
        );
        expect(document.data?.human).toMatchObject({ human: "owner", routing: "named" });
        expect(document.data?.employingHuman).toEqual(human);
        expect(effective?.agent).toBe(runtime.identitySession!.startup.agent);
        expect(effective?.agent).not.toBe("owner");
        expect(effective?.triageRole).toBe("implementer");
      } finally {
        await client.close();
      }
    }));

  it("applies the effective/default role and per-request display override without rewriting the stored role", async () =>
    fixture(async (f) => {
      await f.setup(environment.CODEX_THREAD_ID, "implementer");
      const raw = await f.fs.readText(f.file);
      const { client } = await setup(f, {}, { role: "designer" });
      try {
        const first = identityOf(await client.callTool({ name: "triage_briefing", arguments: {} }));
        expect(first.document.data?.decisionEngine).toMatchObject({ role: { used: "designer" } });
        expect(first.effective).toMatchObject({ role: "designer", triageRole: "implementer" });
        const overridden = identityOf(
          await client.callTool({ name: "triage_briefing", arguments: { role: "implementer" } }),
        );
        expect(overridden.document.data?.decisionEngine).toMatchObject({
          role: { used: "implementer" },
        });
        expect(overridden.effective).toMatchObject({
          role: "implementer",
          roleSource: "explicit",
          triageRole: "implementer",
          startup: { result: { role: "designer" } },
        });
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await client.close();
      }
    }));

  it("carries identifiable startup history in the actual events response", async () =>
    fixture(async (f) => {
      const { client } = await setup(f);
      try {
        const response = await client.callTool({ name: "triage_events", arguments: {} });
        const document = response.structuredContent as {
          effectiveIdentity: ServerEffectiveIdentity;
        };
        expect(document.effectiveIdentity).toMatchObject({
          setup: { state: "reused", notices: [] },
          startup: { phase: "local-server-startup", result: { setup: { state: "created" } } },
        });
        expect(resultBytes(response)).toBeLessThanOrEqual(budgetBytes);
      } finally {
        await client.close();
      }
    }));

  it("preserves verified Ori client display focus without binding it as execution identity", async () =>
    fixture(async (f) => {
      await f.fs.writeText(
        f.file,
        'schemaVersion = 1\n[agents."ori.reader"]\nname = "read_focus"\ntriage_role = "designer"\n',
      );
      const raw = await f.fs.readText(f.file);
      const { client } = await setup(
        f,
        { env: { ORI_SESSION_ID: "private-ori-session" } },
        {},
        "ori-reader",
      );
      try {
        const { document, effective } = identityOf(
          await client.callTool({ name: "triage_briefing", arguments: {} }),
        );
        expect(document.selection).toMatchObject({
          agent: "read_focus",
          identitySource: "client",
          entry: "ori.reader",
        });
        expect(effective).toMatchObject({ state: "unresolved", agent: null });
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await client.close();
      }
    }));

  it("reuses the default only from verified harness evidence, never from a generic client name (#1047)", async () =>
    fixture(async (f) => {
      await f.fs.writeText(
        f.file,
        'schemaVersion = 1\n[agents.codex]\nname = "another_agent"\ntriage_role = "designer"\n',
      );
      const raw = await f.fs.readText(f.file);
      // A Codex-like client name with no verified harness environment selects nothing.
      const unverified = await setup(f, { env: {} }, {}, "codex-mcp-client");
      try {
        const { document, effective } = identityOf(
          await unverified.client.callTool({ name: "triage_briefing", arguments: {} }),
        );
        expect(document.selection).toMatchObject({ agent: null, identitySource: "unresolved" });
        expect(effective).toMatchObject({ state: "unresolved", agent: null });
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await unverified.client.close();
      }
      // A verified Codex execution reuses the harness default's name and role.
      const verified = await setup(f, {}, {}, "codex-mcp-client");
      try {
        const { document } = identityOf(
          await verified.client.callTool({ name: "triage_briefing", arguments: {} }),
        );
        expect(document.selection).toMatchObject({ agent: "another_agent" });
      } finally {
        await verified.client.close();
      }
    }));
  it("keeps real stdio framing valid when startup creates an identity, then reuses it", async () =>
    fixture(async (f) => {
      execFileSync("git", ["init", "-q"], { cwd: f.root });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${f.repository}.git`], {
        cwd: f.root,
      });
      let firstAgent: string | null = null;
      let raw: string | null = null;
      for (let i = 0; i < 2; i++) {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(new URL("../mcp.ts", import.meta.url)),
            "--repo",
            f.repository,
            "--project",
            f.root,
            "--role",
            "implementer",
          ],
          cwd: f.root,
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            CODEX_VERSION: "0.169.0",
            CODEX_THREAD_ID: "stdio-fixture-thread",
            PDB_NO_EFFECTIVE_IDENTITY: "",
            PDB_NO_HUMAN_CONTEXT: "1",
            SENTRY_DISABLED: "1",
          },
        });
        const client = new Client({ name: "real-stdio-fixture", version: "1.0.0" });
        let stderr = "";
        try {
          await client.connect(transport);
          transport.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          const response = await client.callTool({ name: "triage_events", arguments: {} });
          const identity = (
            response.structuredContent as { effectiveIdentity: ServerEffectiveIdentity }
          ).effectiveIdentity;
          expect(identity.setup).toMatchObject({ state: "reused", notices: [] });
          expect(identity.human).toMatchObject({
            state: "unresolved",
            login: null,
            reason: expect.stringContaining("disabled"),
          });
          expect(identity.startup.result.setup.state).toBe(i === 0 ? "created" : "reused");
          if (i === 0) {
            firstAgent = identity.agent;
            raw = await f.fs.readText(f.file);
          } else {
            expect(identity.agent).toBe(firstAgent);
            expect(await f.fs.readText(f.file)).toBe(raw);
          }
          expect(JSON.stringify(response)).not.toContain("stdio-fixture-thread");
        } finally {
          await client.close();
        }
        if (i === 0) expect(stderr).toContain("created agent identity");
        else expect(stderr).not.toContain("created agent identity");
      }
    }));
});
