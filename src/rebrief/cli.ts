import type { PrepareCommandIdentity } from "../config/commandidentity.js";
import type { EffectiveIdentity } from "../config/effectiveidentity.js";
import { effectiveReadIdentity } from "../config/serveridentity.js";
import type { Readable } from "node:stream";
import { codexResponse } from "./codex.js";
/** Opt-in process-per-hook wrapper. No native hooks or repository configuration are written. */
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { collect, ghQueryWith, ghRest } from "../github/github.js";
import { createGhService, type GhService } from "../github/service/service.js";
import { collectShortlist } from "../github/shortlist.js";
import { dependencyReport } from "../github/dependencies.js";
import { resolveIdentityTarget } from "../config/identity.js";
import { validateHarness } from "../config/harness.js";
import { validateEntryKey } from "../config/identity.js";
import type { ReadIdentity } from "../config/readidentity.js";
import { resolveReadIdentity } from "../config/readidentity.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { createGitService, type GitContext, type GitService } from "../git/service.js";

const bindGitSignal = (svc: GitService, signal: AbortSignal): GitService => {
  const withSignal = (ctx: GitContext): GitContext => {
    signal.throwIfAborted();
    return { ...ctx, signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal };
  };
  return {
    workingTreeRoot: (ctx) => svc.workingTreeRoot(withSignal(ctx)),
    commonDirectory: (ctx) => svc.commonDirectory(withSignal(ctx)),
    remotes: (ctx) => svc.remotes(withSignal(ctx)),
    checkout: (ctx) => svc.checkout(withSignal(ctx)),
    revision: (ctx) => svc.revision(withSignal(ctx)),
    headRef: (ctx) => svc.headRef(withSignal(ctx)),
    isAncestor: (ctx, ancestor, descendant) =>
      svc.isAncestor(withSignal(ctx), ancestor, descendant),
    divergence: (ctx, left, right) => svc.divergence(withSignal(ctx), left, right),
    isIgnored: (ctx, path) => svc.isIgnored(withSignal(ctx), path),
    isTracked: (ctx, path) => svc.isTracked(withSignal(ctx), path),
    gitPath: (ctx, path) => svc.gitPath(withSignal(ctx), path),
  };
};
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
  prepareIdentity?: PrepareCommandIdentity;
  input?: Readable;
  currentRepository?: (cwd?: string, signal?: AbortSignal) => Promise<string>;
  gh?: GhService;
  git?: GitService | GitRunner;
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
  if (args[0] === "codex-stop") return runCodexStop(args.slice(1), output, runtime);
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
  let effectiveIdentity: EffectiveIdentity | undefined;
  const emit = async (result: Result) =>
    output(
      `${JSON.stringify({ ...result, ...(effectiveIdentity ? { effectiveIdentity } : {}), ...(identityMetadata ? { identity: identityMetadata } : {}) })}\n`,
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
  const legacyGit: GitRunner | undefined =
    typeof runtime.git === "function"
      ? (args, cwd) => {
          controller.signal.throwIfAborted();
          return (runtime.git as GitRunner)(args, cwd, controller.signal);
        }
      : typeof runtime.git === "object"
        ? async (args, cwd) => {
            controller.signal.throwIfAborted();
            const svc = runtime.git as GitService;
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
              return `${(await svc.workingTreeRoot({ cwd, signal: controller.signal })) ?? ""}\n`;
            if (args[0] === "remote" && args[1] === "-v")
              return (await svc.remotes({ cwd, signal: controller.signal }))
                .map((r) => `${r.name}\t${r.url} (fetch)\n`)
                .join("");
            throw new Error(`Unsupported git args in rebrief adapter: ${args.join(" ")}`);
          }
        : undefined;
  const git: GitService = bindGitSignal(
    typeof runtime.git === "object"
      ? runtime.git
      : createGitService(legacyGit ? { git: legacyGit } : {}),
    controller.signal,
  );
  const gh =
    runtime.gh ??
    runtime.read?.gh ??
    createGhService({
      ...(runtime.read?.rest ? { rest: runtime.read.rest } : {}),
      ...(runtime.read?.query && !runtime.read.queryWith ? { query: runtime.read.query } : {}),
    });
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
        (await (runtime.currentRepository ?? ((cwd, signal) => gh.repos.fromCheckout(cwd, signal)))(
          values.project,
          controller.signal,
        ));
      if (values.project)
        input.project = (await resolveIdentityTarget(values.project, input.repository, git)).root;
      effectiveIdentity = runtime.prepareIdentity
        ? await runtime.prepareIdentity({
            project: input.project,
            repository: input.repository,
            agent: values.agent,
            entry: values.entry,
            harness: values.harness,
            role: values.role,
            requireProject: true,
            intent: "readonly",
          })
        : undefined;
      const identity = effectiveIdentity
        ? effectiveReadIdentity(effectiveIdentity, "tool")
        : await resolveReadIdentity({
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
                collect: (repo, opts, injected, now) =>
                  injected
                    ? collect(repo, opts, injected, now)
                    : gh.snapshot.collect(repo, opts, now),
                collectShortlist: (repo, opts, injected, now) =>
                  injected
                    ? collectShortlist(repo, opts, injected, now)
                    : gh.snapshot.collectShortlist(repo, opts, now),
                dependencyReport,
                gh,
                ...(runtime.gh || runtime.read?.gh
                  ? {}
                  : {
                      rest: ghRest,
                      queryWith: runtime.read ? undefined : ghQueryWith,
                    }),
                ...runtime.read,
                ...(input.project
                  ? {
                      guide: { cwd: input.project, fs: runtime.fs, git: legacyGit },
                      estimation: { cwd: input.project, fs: runtime.fs, git: legacyGit },
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

const codexHelp = `Usage: pdb rebrief codex-stop --state-dir PATH --repo owner/name
       --role implementer|designer [--agent NAME] [--project PATH]
       [--entry KEY | --harness NAME] --natural-stop-confirmed
       [--deadline-ms 1..10000] [--cap 1..3] [--transport service|http-mcp]
Experimental native Codex adapter: one JSON Stop event on stdin, one native JSON
response on stdout. Requires explicit rebrief init for the actual session, same
selection and --platform codex, in a private temporary state directory.
Without controlled natural-stop confirmation, missing/mismatched state, reentry,
invalid input, cancellation or failure: {} and exit 0. No transcript access,
implicit initialization, retries, update check or delivery acknowledgement.
HTTP MCP lacks fresh-read capability and permits normal stop. Native timeout must
exceed the package deadline. Exact hook definition requires normal native trust.
No hook is installed. See doc/rebrief.md for setup/removal and trial limits.
`;

/** Native framing over the existing CLI/core; wrappers contain no JSON or policy logic. */
async function runCodexStop(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: CliRuntime,
): Promise<number> {
  if (args.includes("--help")) {
    await output(codexHelp);
    return 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const input = runtime.input ?? process.stdin;
  const cancelInput = () => input.destroy(new Error("cancelled"));
  // Destroying an unread stream needs an error listener as well as the async iterator.
  const ignoreInputError = () => {};
  input.setEncoding("utf8");
  input.on("error", ignoreInputError);
  controller.signal.addEventListener("abort", cancelInput, { once: true });
  runtime.signal?.addEventListener("abort", abort, { once: true });
  if (!runtime.signal) {
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: ReturnType<typeof codexResponse> = {};
  try {
    const { values } = parseArgs({
      args,
      options: {
        "state-dir": { type: "string" },
        repo: { type: "string" },
        project: { type: "string" },
        agent: { type: "string" },
        role: { type: "string" },
        entry: { type: "string" },
        harness: { type: "string" },
        "natural-stop-confirmed": { type: "boolean" },
        "deadline-ms": { type: "string" },
        cap: { type: "string" },
        transport: { type: "string" },
      },
    });
    const deadline = Number(values["deadline-ms"] ?? defaults.deadlineMs);
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > defaults.deadlineMs)
      throw new Error("invalid deadline");
    if (!values["natural-stop-confirmed"] || runtime.signal?.aborted)
      throw new Error("not natural");
    // Repository selection must be explicit even when a local project supplies identity.
    if (!values.repo) throw new Error("missing repository");
    timer = setTimeout(abort, deadline);
    let raw = "";
    let bytes = 0;
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8192) throw new Error("input bound");
      raw += String(chunk);
    }
    controller.signal.throwIfAborted();
    const event: unknown = JSON.parse(raw);
    const id = (v: unknown): v is string =>
      typeof v === "string" && v.length > 0 && v.length <= 256 && /^\S+$/.test(v);
    if (
      !event ||
      typeof event !== "object" ||
      !("hook_event_name" in event) ||
      event.hook_event_name !== "Stop" ||
      !("session_id" in event) ||
      !id(event.session_id) ||
      !("turn_id" in event) ||
      !id(event.turn_id) ||
      !("stop_hook_active" in event) ||
      event.stop_hook_active !== false
    )
      throw new Error("ineligible event");
    const check = [
      "check",
      "--json",
      "--enabled",
      "--reason",
      "natural",
      "--platform",
      "codex",
      "--session",
      event.session_id,
      "--event",
      event.turn_id,
    ];
    for (const [key, value] of Object.entries(values))
      if (typeof value === "string") check.push(`--${key}`, value);
    await runRebrief(
      check,
      async (text) => {
        const result = JSON.parse(text) as Result;
        response = codexResponse(result);
      },
      { ...runtime, signal: controller.signal },
    );
  } catch {
    response = {};
  } finally {
    if (timer) clearTimeout(timer);
    runtime.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cancelInput);
    input.removeListener("error", ignoreInputError);
    if (!runtime.signal) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  await output(`${JSON.stringify(controller.signal.aborted ? {} : response)}\n`);
  return 0;
}
