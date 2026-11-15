import { describe, expect, it } from "vite-plus/test";
import { codexStop } from "./codex.js";
import { initialize, RebriefSession } from "./core.js";
import { serviceTransport } from "./transports.js";
import { noLocalProject } from "../serve/api.js";
import { dependencyReport } from "../github/dependencies.js";
import { clock, issue, repo, snapshot } from "../testing/snapshots.js";
const binding = {
  repository: repo,
  agent: "probe",
  role: "implementer" as const,
  platform: "codex",
  session: "synthetic-session",
  enabled: true,
  naturalStopConfirmed: true,
  userStopped: false,
};
const event = {
  hook_event_name: "Stop",
  session_id: binding.session,
  turn_id: "synthetic-turn",
  stop_hook_active: false,
};
const runtime = {
  now: () => clock().getTime(),
  transport: serviceTransport({
    ...noLocalProject(repo),
    now: clock,
    collect: async () => snapshot([issue(1, ["status:ready", "platform:codex"])], []),
    dependencyReport,
  }),
};
describe("Codex Stop translation (synthetic, not native receipt)", () => {
  it("delivers exactly the shared-core briefing without acknowledging it", async () => {
    const session = new RebriefSession(initialize(binding));
    const offer = await codexStop(event, binding, session, runtime);
    expect(offer.response).toEqual({ decision: "block", reason: offer.result?.briefing });
    expect(offer.result?.decision).toBe("continue");
    expect(session.state?.delivered).toBeNull();
    expect(session.state?.events[0].delivery).toBe("offered");
    expect((await codexStop(event, binding, session, runtime)).response).toEqual({});
  });
  it("allows normal stop for reentry, wrong session, unknown provenance, interruption and missing state", async () => {
    for (const [e, b] of [
      [{ ...event, stop_hook_active: true }, binding],
      [{ ...event, session_id: "wrong" }, binding],
      [event, { ...binding, naturalStopConfirmed: false }],
      [event, { ...binding, userStopped: true }],
      [{ ...event, hook_event_name: "Interrupt" }, binding],
    ] as const) {
      expect(
        (await codexStop(e, b, new RebriefSession(initialize(binding)), runtime)).response,
      ).toEqual({});
    }
    expect((await codexStop(event, binding, new RebriefSession(null), runtime)).response).toEqual(
      {},
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await codexStop(
          event,
          binding,
          new RebriefSession(initialize(binding)),
          runtime,
          controller.signal,
        )
      ).response,
    ).toEqual({});
  });
});
