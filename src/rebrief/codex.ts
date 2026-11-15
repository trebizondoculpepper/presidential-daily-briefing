/** Thin, opt-in Codex Stop translation. Event provenance and delivery receipt stay native. */
import type { Input, RebriefSession, Result, Runtime } from "./core.js";
export interface CodexStopEvent {
  hook_event_name: string;
  session_id: string;
  turn_id: string;
  stop_hook_active: boolean;
}
export interface CodexBinding extends Omit<Input, "eventId" | "reason"> {
  naturalStopConfirmed: boolean;
  userStopped: boolean;
}
export interface CodexOffer {
  response: { decision: "block"; reason: string } | Record<string, never>;
  result: Result | null;
}
/** Does not acknowledge delivery: stdout emission is not model-visible receipt. */
export async function codexStop(
  event: CodexStopEvent,
  binding: CodexBinding,
  session: RebriefSession,
  runtime: Runtime,
  signal?: AbortSignal,
): Promise<CodexOffer> {
  if (
    event.hook_event_name !== "Stop" ||
    !event.turn_id ||
    event.session_id !== binding.session ||
    event.stop_hook_active ||
    !binding.naturalStopConfirmed ||
    binding.userStopped ||
    signal?.aborted
  )
    return { response: {}, result: null };
  const result = await session.evaluate(
    { ...binding, eventId: event.turn_id, reason: "natural" },
    runtime,
    signal,
  );
  return {
    response:
      !binding.userStopped && !signal?.aborted && result.decision === "continue" && result.briefing
        ? { decision: "block", reason: result.briefing }
        : {},
    result,
  };
}
