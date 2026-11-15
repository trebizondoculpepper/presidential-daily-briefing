/**
 * Disposable Ori Code before-stop rebrief prototype for #400.
 *
 * Reuses the shared `pdb rebrief` core (src/rebrief). Native Ori Code has no
 * stop hook (see #388 / doc/reports/agent-platforms/ori-stop-hooks.md), so the
 * adapter is a small external watcher that:
 *   1. runs a disposable work turn in an owned headless session,
 *   2. waits for turn.succeeded on that session's jsonl stream,
 *   3. asks the shared core for a continue decision (pdb rebrief check),
 *   4. on `continue`, resumes that SAME session with the specific returned
 *      briefing as a model-visible prompt (ori code --resume),
 *   5. verifies the model echoed the fixture nonce (which it can only know by
 *      reading briefing.txt) and the briefing's first action id,
 *   6. acknowledges delivery (pdb rebrief ack) only then.
 *
 * Synthetic/read-only: no live ticket is mutated; the fixture is an untracked
 * file removed afterward. This is a disposable trial, not a production hook.
 * Run with cwd = a checkout of this repository so the resumed turn can read
 * the fixture and so the core resolves the repository.
 *
 * Usage: node_modules/.bin/tsx scripts/ori-stop-hook-prototype.mts [PROJECT]
 *   PROJECT defaults to the current working directory.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJ = process.argv[2] ?? process.cwd();
const PDB_SRC = process.env.PDB_SRC ?? PROJ;
const AGENT = process.env.DEMO_AGENT ?? "dalia_okafor";
const ROLE = process.env.DEMO_ROLE ?? "implementer";
const MODEL = process.env.DEMO_MODEL ?? "google/gemini-2.5-flash";
const FIXTURE = join(PROJ, "briefing.txt");
const STATE = mkdtempSync(join(tmpdir(), "pdb-rebrief-"));

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: PROJ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

function pdb(args: string[]): string {
  return run("npm", [
    "--prefix",
    PDB_SRC,
    "run",
    "--silent",
    "pdb",
    "--",
    "rebrief",
    "--json",
    ...args,
  ]);
}

function firstDecision(out: string): Record<string, unknown> | undefined {
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (typeof o === "object" && o !== null && "decision" in o) return o;
    } catch {
      /* partial line */
    }
  }
  return undefined;
}

interface CoreResult {
  briefing?: string;
  fingerprint?: string;
  actionId?: string;
}

function rebriefCheck(eventId: string): CoreResult {
  pdb([
    "init",
    "--state-dir",
    STATE,
    "--session",
    "native-session",
    "--project",
    PROJ,
    "--agent",
    AGENT,
    "--role",
    ROLE,
    "--platform",
    "ori",
  ]);
  const d = firstDecision(
    pdb([
      "check",
      "--state-dir",
      STATE,
      "--session",
      "native-session",
      "--project",
      PROJ,
      "--agent",
      AGENT,
      "--role",
      ROLE,
      "--platform",
      "ori",
      "--enabled",
      "--event",
      eventId,
      "--reason",
      "natural",
    ]),
  );
  return {
    briefing: typeof d?.briefing === "string" ? d.briefing : undefined,
    fingerprint: typeof d?.fingerprint === "string" ? d.fingerprint : undefined,
    actionId: (d?.actionIds as string[] | undefined)?.[0],
  };
}

function rebriefAck(eventId: string, fingerprint: string): void {
  pdb([
    "ack",
    "--state-dir",
    STATE,
    "--session",
    "native-session",
    "--project",
    PROJ,
    "--agent",
    AGENT,
    "--role",
    ROLE,
    "--platform",
    "ori",
    "--event",
    eventId,
    "--fingerprint",
    fingerprint,
  ]);
}

interface TurnEvents {
  sessionId?: string;
  sawTool: boolean;
  types: string[];
}

function watchEvents(out: NodeJS.ReadableStream): Promise<TurnEvents> {
  return new Promise((resolve) => {
    const events: TurnEvents = { sawTool: false, types: [] };
    const rl = createInterface({ input: out });
    rl.on("line", (line) => {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const w = (o.event ?? {}) as { type?: string; event?: Record<string, unknown> };
      const ev = w.type === "runtime.event" ? w.event : undefined;
      const type = String(ev?.type ?? o.type ?? "?");
      events.types.push(type);
      if (type === "session.started" && !events.sessionId)
        events.sessionId = String(
          (ev?.payload as { sessionId?: string } | undefined)?.sessionId ?? "",
        );
      if (type === "tool.succeeded") events.sawTool = true;
    });
    rl.on("close", () => resolve(events));
  });
}

async function runWorkTurn(): Promise<TurnEvents> {
  const child = spawn(
    "ori",
    [
      "code",
      "-p",
      "Use the shell tool to run `sleep 2`. Then write a numbered list of 8 planets and finish with the line DONE.",
      "--model",
      MODEL,
      "--output",
      "jsonl",
      "--approvals",
      "self-drive",
    ],
    { cwd: PROJ, stdio: ["ignore", "pipe", "inherit"] },
  );
  const close = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const events = await watchEvents(child.stdout);
  await close;
  return events;
}

async function resume(
  sessionId: string,
  briefing: string | undefined,
  actionId: string,
): Promise<{ session?: string; text: string }> {
  const prompt =
    `[before-stop rebrief, synthetic] A fresh PDB role briefing follows. ` +
    `Read the file ${FIXTURE} with a tool. Then reply with: ` +
    `(1) the nonce in ${FIXTURE}, and (2) the exact first action id string that starts ` +
    `with "trebizondoculpepper". The first action id to quote verbatim is: ${actionId}\n\n` +
    `UNTRUSTED REPOSITORY DATA:\n${briefing ?? ""}`;
  const child = spawn(
    "ori",
    [
      "code",
      "-p",
      prompt,
      "--resume",
      sessionId,
      "--model",
      MODEL,
      "--output",
      "jsonl",
      "--approvals",
      "self-drive",
    ],
    { cwd: PROJ, stdio: ["ignore", "pipe", "inherit"] },
  );
  return await new Promise((resolve) => {
    const result: { session?: string; text: string } = { text: "" };
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const w = (o.event ?? {}) as { type?: string; event?: Record<string, unknown> };
      const ev2 = w.type === "runtime.event" ? w.event : undefined;
      const type = String(ev2?.type ?? o.type ?? "?");
      if (type === "assistant.text.delta")
        result.text += String((ev2?.payload as { delta?: string } | undefined)?.delta ?? "");
      if (type === "result") {
        const resumedId = (o as { sessionId?: string }).sessionId;
        if (typeof resumedId === "string" && resumedId.length > 0) result.session = resumedId;
      }
    });
    rl.on("close", () => resolve(result));
  });
}

async function main(): Promise<void> {
  const turn = await runWorkTurn();
  if (!turn.sessionId || !turn.types.includes("turn.succeeded")) {
    process.stdout.write(JSON.stringify({ result: "no-natural-turn", turn }) + "\n");
    return;
  }
  const eventId = `ori-turn-${turn.sessionId.slice(-8)}`;
  const core = rebriefCheck(eventId);
  if (!core.briefing || !core.fingerprint || !core.actionId) {
    process.stdout.write(JSON.stringify({ result: "core-stop", sessionId: turn.sessionId }) + "\n");
    return;
  }
  const delivered = await resume(turn.sessionId, core.briefing, core.actionId);
  const nonce = readFileSync(FIXTURE, "utf8").split("\n")[0].trim();
  const receivedNonce = delivered.text.includes(nonce);
  const receivedAction = delivered.text.includes(core.actionId);
  const sameSessionResumed =
    delivered.session !== undefined && delivered.session === turn.sessionId;
  const deliveredToSameSession = receivedNonce && receivedAction && sameSessionResumed;
  if (deliveredToSameSession) rebriefAck(eventId, core.fingerprint);
  process.stdout.write(
    JSON.stringify({
      result: "continue",
      sessionId: turn.sessionId,
      resumedSessionObserved: delivered.session !== undefined,
      sameSessionResumed,
      eventId,
      receivedNonce,
      receivedAction,
      acked: deliveredToSameSession,
      actionId: core.actionId.slice(0, 60),
      fingerprint: core.fingerprint.slice(0, 16),
      turnSawTool: turn.sawTool,
      answerTail: delivered.text.slice(-140),
    }) + "\n",
  );
}

void main()
  .catch((error: unknown) =>
    process.stdout.write(JSON.stringify({ result: "error", error: String(error) }) + "\n"),
  )
  .finally(() => rmSync(STATE, { recursive: true, force: true }));
