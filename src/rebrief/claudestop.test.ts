/** Packaged Claude Code Stop adapter (#771): synthetic stdin events and injected transports only. */
import { describe, expect, it } from "vite-plus/test";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRebrief } from "./cli.js";
import { serviceTransport } from "./transports.js";
import { noLocalProject } from "../serve/api.js";
import { dependencyReport } from "../github/dependencies.js";
import { snapshot, issue, repo } from "../testing/snapshots.js";
import type { Transport } from "./core.js";

/** The documented Claude Code Stop payload shape (no turn_id; prompt_id per Stop). */
const event = {
  hook_event_name: "Stop",
  session_id: "s",
  prompt_id: "p1",
  stop_hook_active: false,
  cwd: "/project",
  transcript_path: "/private/transcript.jsonl",
  permission_mode: "default",
  last_assistant_message: "Done.",
  background_tasks: [],
  session_crons: [],
};
const selection = ["--repo", repo, "--agent", "probe", "--role", "implementer"];
const transport = serviceTransport({
  ...noLocalProject(repo),
  collect: async () => {
    const stamp = new Date().toISOString();
    return { ...snapshot([issue(1, ["status:ready"])], []), startedAt: stamp, fetchedAt: stamp };
  },
  dependencyReport,
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pdb-claude-stop-"));
  const args = ["--state-dir", dir, ...selection];
  await runRebrief(
    ["init", ...args, "--json", "--session", "s", "--platform", "claude-code"],
    async () => {},
  );
  return { dir, args };
}

describe("packaged Claude Code Stop adapter (#771)", () => {
  it("blocks once with the briefing, keeps the offer pending, and refuses re-entry and duplicates", async () => {
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
        ["claude-stop", ...args, "--natural-stop-confirmed", ...extra],
        async (s) => {
          text += s;
        },
        { input: Readable.from([JSON.stringify(e)]), transport: () => read },
      );
      expect(code).toBe(0);
      return JSON.parse(text) as { decision?: string; reason?: string };
    };
    try {
      // A Stop already continued by a hook, a foreign session or a missing prompt_id: no read.
      expect(await invoke({ ...event, stop_hook_active: true })).toEqual({});
      expect(await invoke({ ...event, session_id: "foreign" })).toEqual({});
      const { prompt_id: _omitted, ...noPrompt } = event;
      expect(await invoke(noPrompt)).toEqual({});
      // Paused for background work, not finished: stop normally without a read.
      expect(
        await invoke({ ...event, background_tasks: [{ id: "t", status: "running" }] }),
      ).toEqual({});
      expect(await invoke({ ...event, session_crons: [{ id: "c", recurring: true }] })).toEqual({});
      expect(reads).toBe(0);
      const first = await invoke(event);
      expect(first.decision).toBe("block");
      expect(first.reason).toContain("Inspect this fresh PDB briefing");
      // The same prompt_id is a duplicate; a new one meets the pending (unacknowledged) offer.
      expect(await invoke(event)).toEqual({});
      expect(await invoke({ ...event, prompt_id: "p2" })).toEqual({});
      expect(reads).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires explicit natural-stop confirmation and a well-formed event, without reads", async () => {
    const { dir, args } = await setup();
    let reads = 0;
    try {
      for (const [raw, extra, confirm] of [
        [JSON.stringify(event), [], false],
        ["{", [], true],
        [JSON.stringify({ ...event, prompt_id: "x".repeat(257) }), [], true],
        [JSON.stringify({ ...event, hook_event_name: "StopFailure" }), [], true],
        [JSON.stringify(event), ["--session", "foreign"], true],
      ] as const) {
        let text = "";
        expect(
          await runRebrief(
            ["claude-stop", ...args, ...(confirm ? ["--natural-stop-confirmed"] : []), ...extra],
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
        expect(JSON.parse(text)).toEqual({});
      }
      expect(reads).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("documents itself without reading stdin", async () => {
    let text = "";
    await runRebrief(["claude-stop", "--help"], async (s) => void (text += s));
    expect(text).toContain("pdb rebrief claude-stop");
    expect(text).toContain("stop_hook_active");
    expect(text).toContain("not delivery receipt");
  });
});
