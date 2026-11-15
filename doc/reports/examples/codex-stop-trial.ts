/** Disposable #398 native trial entry. Never installs hooks or invokes a model. */
import { randomUUID } from "node:crypto";
import { codexStop } from "../../../src/rebrief/codex.js";
import type { CodexStopEvent } from "../../../src/rebrief/codex.js";
import { RebriefSession } from "../../../src/rebrief/core.js";
import { serviceTransport } from "../../../src/rebrief/transports.js";
import { withPrivateState } from "../../../src/rebrief/state.js";
import { noLocalProject } from "../../../src/serve/api.js";
import { dependencyReport } from "../../../src/github/dependencies.js";
import { issue, repo, snapshot } from "../../../src/testing/snapshots.js";
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
controller.signal.addEventListener("abort", () => process.stdin.destroy(new Error("cancelled")), {
  once: true,
});
const timer = setTimeout(() => controller.abort(), 5000);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 8192) throw new Error("input bound");
  }
  const event = JSON.parse(input) as CodexStopEvent;
  if (
    typeof event.session_id !== "string" ||
    typeof event.turn_id !== "string" ||
    typeof event.stop_hook_active !== "boolean" ||
    event.hook_event_name !== "Stop"
  )
    throw new Error("invalid event");
  const binding = {
    repository: repo,
    agent: "probe",
    role: "implementer" as const,
    platform: "codex",
    session: event.session_id,
    enabled: true,
    naturalStopConfirmed: process.argv.includes("--natural-stop-confirmed"),
    userStopped: false,
  };
  const transport = serviceTransport({
    ...noLocalProject(repo),
    collect: async () => {
      const stamp = new Date().toISOString();
      return {
        ...snapshot([issue(1, ["status:ready", "platform:codex"])], []),
        startedAt: stamp,
        fetchedAt: stamp,
      };
    },
    dependencyReport,
  });
  const read = transport.read;
  transport.read = async (...args) => {
    const result = await read(...args);
    return {
      ...result,
      text: `Synthetic read-only trial. Do not run commands or claim any ticket. Reply only with receipt ${randomUUID()}.\n${result.text}`,
    };
  };
  const response = await withPrivateState(process.argv[2], async (state, save) => {
    const session = new RebriefSession(state);
    const offer = await codexStop(event, binding, session, { transport }, controller.signal);
    if (session.state) await save(session.state);
    return offer.response; // No acknowledgement: require separate actual model-visible receipt.
  });
  process.stdout.write(JSON.stringify(controller.signal.aborted ? {} : response));
} catch {
  process.stdout.write("{}");
} finally {
  clearTimeout(timer);
}
