/** Opt-in process-per-hook wrapper. No native hooks or repository configuration are written. */
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { collect, currentRepository, ghQueryWith, ghRest } from "../github/github.js";
import { dependencyReport } from "../github/dependencies.js";
import { resolveIdentityTarget } from "../config/identity.js";
import { validateHarness } from "../config/harness.js";
import { validateEntryKey } from "../config/identity.js";
import type { ReadIdentity } from "../config/readidentity.js";
import { resolveReadIdentity } from "../config/readidentity.js";
import { nodeGit } from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { noLocalProject } from "../serve/api.js";
import { contextKey, defaults, initialize, RebriefSession, stopped } from "./core.js";
import type { ReadRuntime } from "../briefing/service.js";
import type { Context, Input, Result, Transport } from "./core.js";
import { httpMcpTransport, serviceTransport } from "./transports.js";
import { withPrivateState } from "./state.js";

export const rebriefHelp = `Usage: pdb rebrief init|check|ack --json --state-dir PATH --session ID
       (--repo owner/name | --project /absolute/checkout) --platform NAME
       --role implementer|designer [--agent NAME] [--entry KEY | --harness NAME]
       check: --enabled --event ID --reason natural [--deadline-ms 1..10000] [--cap 1..3]
       ack:   --event ID --fingerprint SHA256
init explicitly creates a new session budget in an existing private temporary directory;
it never resets existing state. check offers at most three changed briefings per session.
ack is for a native adapter AFTER it establishes exact event/fingerprint delivery. Ambiguous
delivery stops. State holds only context/event hashes, fingerprints, counts and delivery state.
--state-dir must be private, under the OS temporary directory, outside a Git tree.
--transport service (default) reads the live shared service once; http-mcp reports its missing
fresh-read/platform capability and stops without a request. No retry, model, mutation, hook
activation, update check or repository config write. No implicit cwd project selection.
Disabled opt-in, user stop, unknown reason, lost state, empty/unchanged/incomplete/stale evidence
stop normally. A defer also allows normal stop; it is not a retry. JSON is NOT a native hook
response: Codex/Claude/Ori adapters translate it and must establish model-visible receipt.
Remove YOUR disposable state directory after stopping its adapter; no other uninstall needed.
Exit: 0 structured decision (including stop/defer); 1 invalid arguments/setup.\n`;
export interface CliRuntime {
  currentRepository?: typeof currentRepository;
  git?: GitRunner;
  fs?: ConfigFileSystem;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  transport?: (context: Context) => Transport;
  read?: ReadRuntime;
  state?: typeof withPrivateState;
}
export async function runRebrief(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: CliRuntime = {},
): Promise<number> {
  let input: Input = {
    repository: "",
    agent: "",
    role: "implementer",
    platform: "",
    session: "",
    eventId: "",
    reason: "unknown",
    enabled: false,
  };
  let identityMetadata:
    | Pick<ReadIdentity, "source" | "store" | "diagnostic" | "storeDiagnostic">
    | undefined;
  const emit = async (result: Result) =>
    output(
      `${JSON.stringify({ ...result, ...(identityMetadata ? { identity: identityMetadata } : {}) })}\n`,
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  runtime.signal?.addEventListener("abort", abort, { once: true });
  if (runtime.signal?.aborted) abort();
  if (!runtime.signal) {
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
  }
  const cancellable = async <T>(work: Promise<T>): Promise<T> => {
    let cancel: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("cancelled"));
    });
    if (controller.signal.aborted) cancel();
    else controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      controller.signal.removeEventListener("abort", cancel);
    }
  };
  const git: GitRunner = (args, cwd) => {
    controller.signal.throwIfAborted();
    return (runtime.git ?? nodeGit)(args, cwd, controller.signal);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const mode = args[0];
    if (args.includes("--help")) {
      await output(rebriefHelp);
      return 0;
    }
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        json: { type: "boolean" },
        enabled: { type: "boolean" },
        repo: { type: "string" },
        project: { type: "string" },
        agent: { type: "string" },
        entry: { type: "string" },
        harness: { type: "string" },
        platform: { type: "string" },
        role: { type: "string" },
        session: { type: "string" },
        event: { type: "string" },
        reason: { type: "string" },
        "state-dir": { type: "string" },
        fingerprint: { type: "string" },
        "deadline-ms": { type: "string" },
        cap: { type: "string" },
        transport: { type: "string" },
      },
    });
    const valid = (v: string | undefined, re: RegExp): v is string =>
      !!v && v.length <= 256 && re.test(v);
    if (
      !["init", "check", "ack"].includes(mode ?? "") ||
      !values.json ||
      !values["state-dir"] ||
      !isAbsolute(values["state-dir"]) ||
      !valid(values.session, /^\S+$/) ||
      !valid(values.platform, /^[\w.-]+$/) ||
      !["implementer", "designer"].includes(values.role ?? "") ||
      (!values.repo && !values.project) ||
      (values.repo && !valid(values.repo, /^[\w.-]+\/[\w.-]+$/)) ||
      (values.project && !isAbsolute(values.project)) ||
      (values.agent && !valid(values.agent, /^[A-Za-z0-9][\w.-]*$/)) ||
      (values.entry && values.harness) ||
      !["service", "http-mcp"].includes(values.transport ?? "service")
    )
      throw new Error("invalid-input");
    if (values.entry) validateEntryKey(values.entry);
    if (values.harness) validateHarness(values.harness);
    const deadlineMs = Number(values["deadline-ms"] ?? defaults.deadlineMs);
    const cap = Number(values.cap ?? defaults.cap);
    if (
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > defaults.deadlineMs ||
      !Number.isInteger(cap) ||
      cap < 1 ||
      cap > defaults.cap ||
      (mode !== "init" && !valid(values.event, /^\S+$/)) ||
      (mode === "ack" && !valid(values.fingerprint, /^[a-f0-9]{64}$/))
    )
      throw new Error("invalid-input");
    input = {
      ...input,
      repository: values.repo ?? "",
      project: values.project,
      agent: values.agent ?? "",
      platform: values.platform!,
      role: values.role as Context["role"],
      session: values.session!,
      eventId: values.event ?? "",
      reason: values.reason ?? "unknown",
      enabled: !!values.enabled,
      deadlineMs,
      cap,
    };
    if (
      mode === "check" &&
      (!input.enabled || input.reason !== "natural" || controller.signal.aborted)
    ) {
      await emit(
        stopped(
          input,
          controller.signal.aborted || ["cancelled", "user-stop"].includes(input.reason)
            ? "cancelled"
            : !input.enabled
              ? "disabled"
              : "not-natural-stop",
        ),
      );
      return 0;
    }
    timer = setTimeout(abort, deadlineMs);
    const setup = async () => {
      input.repository =
        values.repo ??
        (await (runtime.currentRepository ?? currentRepository)(values.project, controller.signal));
      if (values.project)
        input.project = (await resolveIdentityTarget(values.project, input.repository, git)).root;
      const identity = await resolveReadIdentity({
        toolAgent: values.agent,
        project: input.project,
        repository: input.repository,
        entry: values.entry,
        harness: values.harness,
        env: runtime.env ?? process.env,
        fs: runtime.fs,
        git,
      });
      const bounded = (value: string | null) =>
        value === null || value.length <= 512 ? value : `${value.slice(0, 498)}… [truncated]`;
      identityMetadata = {
        source: identity.source,
        store: identity.store,
        diagnostic: bounded(identity.diagnostic),
        storeDiagnostic: bounded(identity.storeDiagnostic),
      };
      input.agent = identity.agent ?? "";
    };
    await cancellable(setup());
    if (!input.agent) {
      await emit(stopped(input, "missing-identity"));
      return 0;
    }
    const result = await cancellable(
      (runtime.state ?? withPrivateState)(values["state-dir"], async (state, save) => {
        if (controller.signal.aborted) return stopped(input, "cancelled");
        if (mode === "init") {
          if (state) return stopped(input, "state-exists");
          await save(initialize(input));
          return stopped(input, "initialized");
        }
        const session = new RebriefSession(state);
        if (mode === "ack") {
          const accepted = session.acknowledge(input, input.eventId, values.fingerprint!);
          if (accepted) await save(session.state!);
          return stopped(input, accepted ? "acknowledged" : "acknowledgement-refused");
        }
        const transport =
          values.transport === "http-mcp"
            ? httpMcpTransport
            : (runtime.transport?.(input) ??
              serviceTransport({
                collect,
                dependencyReport,
                rest: ghRest,
                queryWith: runtime.read ? undefined : ghQueryWith,
                ...runtime.read,
                ...(input.project
                  ? {
                      guide: { cwd: input.project, fs: runtime.fs, git: runtime.git },
                      estimation: { cwd: input.project, fs: runtime.fs, git: runtime.git },
                    }
                  : noLocalProject(input.repository)),
              }));
        const decision = await session.evaluate(input, { transport }, controller.signal);
        if (session.state && session.state.context === contextKey(input)) await save(session.state);
        return controller.signal.aborted ? stopped(input, "cancelled") : decision;
      }),
    );
    await emit(controller.signal.aborted ? stopped(input, "cancelled") : result);
    return 0;
  } catch {
    await emit(
      stopped(
        input,
        controller.signal.aborted ? "cancelled-or-deadline" : "invalid-input-or-state",
      ),
    );
    return controller.signal.aborted ? 0 : 1;
  } finally {
    if (timer) clearTimeout(timer);
    runtime.signal?.removeEventListener("abort", abort);
    if (!runtime.signal) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}
