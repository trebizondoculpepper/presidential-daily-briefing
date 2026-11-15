import { describe, expect, it } from "vite-plus/test";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRebrief } from "./cli.js";
import { serviceTransport } from "./transports.js";
import { noLocalProject } from "../serve/api.js";
import { dependencyReport } from "../github/dependencies.js";
import { snapshot, issue, repo } from "../testing/snapshots.js";
import type { Transport } from "./core.js";

const event = { hook_event_name: "Stop", session_id: "s", turn_id: "t", stop_hook_active: false };
const selection = ["--repo", repo, "--agent", "literal $() & probe", "--role", "implementer"];
const validSelection = ["--repo", repo, "--agent", "probe", "--role", "implementer"];
const transport = serviceTransport({
  ...noLocalProject(repo),
  collect: async () => {
    const stamp = new Date().toISOString();
    return { ...snapshot([issue(1, ["status:ready"])], []), startedAt: stamp, fetchedAt: stamp };
  },
  dependencyReport,
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pdb codex $() & "));
  const args = ["--state-dir", dir, ...validSelection];
  await runRebrief(
    ["init", ...args, "--json", "--session", "s", "--platform", "codex"],
    async () => {},
  );
  return { dir, args };
}

describe("packaged Codex event boundary", () => {
  it("emits only native feedback, persists the offer and refuses reentry/duplicate/foreign state", async () => {
    const { dir, args } = await setup();
    let reads = 0;
    const read: Transport = {
      ...transport,
      read: async (...a) => {
        reads++;
        return transport.read(...a);
      },
    };
    const invoke = async (e: unknown, extra: string[] = []) => {
      let text = "";
      const code = await runRebrief(
        ["codex-stop", ...args, "--natural-stop-confirmed", ...extra],
        async (s) => {
          text += s;
        },
        { input: Readable.from([JSON.stringify(e)]), transport: () => read },
      );
      expect(code).toBe(0);
      return JSON.parse(text) as { decision?: string; reason?: string };
    };
    try {
      expect(await invoke({ ...event, stop_hook_active: true })).toEqual({});
      expect(await invoke({ ...event, session_id: "foreign" })).toEqual({});
      expect(reads).toBe(0);
      const first = await invoke(event);
      expect(first.decision).toBe("block");
      expect(first.reason).toContain("Inspect this fresh PDB briefing");
      expect(await invoke(event)).toEqual({});
      expect(await invoke({ ...event, turn_id: "new" }, ["--transport", "http-mcp"])).toEqual({});
      expect(reads).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed/oversized events, literal invalid identity and unknown provenance without reads", async () => {
    const { dir, args } = await setup();
    let reads = 0;
    try {
      for (const [raw, extra] of [
        ["{", []],
        [JSON.stringify({ ...event, stop_hook_active: "false" }), []],
        [JSON.stringify({ ...event, turn_id: "x".repeat(257) }), []],
        [JSON.stringify({ ...event, transcript_path: "x".repeat(8192) }), []],
        [JSON.stringify(event), ["--agent", "literal $() & probe"]],
        [JSON.stringify(event), ["--session", "foreign"]],
      ] as const) {
        let text = "";
        expect(
          await runRebrief(
            ["codex-stop", ...args, "--natural-stop-confirmed", ...extra],
            async (s) => {
              text += s;
            },
            {
              input: Readable.from([raw]),
              transport: () => {
                reads++;
                return transport;
              },
            },
          ),
        ).toBe(0);
        expect(text).toBe("{}\n");
      }
      let text = "";
      await runRebrief(
        ["codex-stop", "--state-dir", dir, ...selection],
        async (s) => {
          text += s;
        },
        {
          input: new PassThrough(),
          transport: () => {
            reads++;
            return transport;
          },
        },
      );
      expect(text).toBe("{}\n");
      expect(reads).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bounds unterminated stdin and cancellation during a pending read", async () => {
    const { dir, args } = await setup();
    try {
      let text = "";
      await runRebrief(
        ["codex-stop", ...args, "--natural-stop-confirmed", "--deadline-ms", "10"],
        async (s) => {
          text += s;
        },
        { input: new PassThrough() },
      );
      expect(text).toBe("{}\n");
      text = "";
      const controller = new AbortController();
      let cancelled = false;
      const pending: Transport = {
        freshRead: true,
        read: async (_context, signal) => {
          controller.abort();
          cancelled = !!signal?.aborted;
          throw new Error("PRIVATE");
        },
      };
      await runRebrief(
        ["codex-stop", ...args, "--natural-stop-confirmed"],
        async (s) => {
          text += s;
        },
        {
          input: Readable.from([JSON.stringify(event)]),
          signal: controller.signal,
          transport: () => pending,
        },
      );
      expect(cancelled).toBe(true);
      expect(text).toBe("{}\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
