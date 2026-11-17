import type { ReadIdentity } from "./readidentity.js";
import { TRIAGE_ROLES, type TriageRole } from "./identity.js";
/** Local startup prepares once; remote read/display selection can only resolve existing identities. */
import { posix, win32 } from "node:path";
import { captureBindingEnvironment } from "./activebinding.js";
import {
  prepareEffectiveIdentity,
  type EffectiveIdentity,
  type EffectiveIdentityRuntime,
} from "./effectiveidentity.js";

export interface LocalIdentityOptions {
  readonly project?: string;
  readonly repository?: string;
  readonly agent?: string;
  readonly entry?: string;
  readonly harness?: string;
  readonly role?: string;
}

export interface ServerEffectiveIdentity extends EffectiveIdentity {
  /** Historical startup outcome; current setup is always the non-initializing read above. */
  readonly startup: {
    readonly phase: "local-server-startup";
    readonly repository: string | null;
    readonly result: EffectiveIdentity;
  };
}

/** The trusted local startup context is retained separately from any displayed selection. */
export class LocalIdentitySession {
  readonly #options: LocalIdentityOptions;
  readonly #runtime: EffectiveIdentityRuntime;

  constructor(
    readonly startup: EffectiveIdentity,
    options: LocalIdentityOptions,
    runtime: EffectiveIdentityRuntime,
  ) {
    this.#options = options;
    this.#runtime = runtime;
  }

  async startupRead(): Promise<ServerEffectiveIdentity> {
    return this.read(this.#options.project, this.#options.repository);
  }

  async read(project: string | undefined, repository?: string): Promise<ServerEffectiveIdentity> {
    const platform = this.#runtime.platform ?? process.platform;
    const path = platform === "win32" ? win32 : posix;
    const normalize = (value: string) => {
      const resolved = path.resolve(value);
      return platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const startupProject =
      project !== undefined &&
      this.#options.project !== undefined &&
      normalize(project) === normalize(this.#options.project);
    const result = await prepareEffectiveIdentity(
      {
        project,
        repository,
        requireProject: true,
        // A startup override is trusted local context, never supplied by a tool or HTTP request.
        agent: this.#options.agent,
        ...(startupProject
          ? { entry: this.#options.entry, harness: this.#options.harness, role: this.#options.role }
          : {}),
        intent: "readonly",
      },
      this.#runtime,
    );
    return {
      ...result,
      startup: {
        phase: "local-server-startup",
        repository: this.#options.repository ?? null,
        result: this.startup,
      },
    };
  }
}

/** Called by the local entry point, before listeners/pollers; never by a read request. */
export async function startLocalIdentity(
  options: LocalIdentityOptions,
  runtime: EffectiveIdentityRuntime,
): Promise<LocalIdentitySession> {
  const fixed = { ...runtime, env: captureBindingEnvironment(runtime.env) };
  const startup = await prepareEffectiveIdentity(
    {
      ...options,
      requireProject: true,
      intent: options.project ? "normal" : "readonly",
      authenticationRequired: true,
    },
    fixed,
  );
  return new LocalIdentitySession(startup, { ...options }, fixed);
}

/** Per-request display role metadata; neither agent selection nor persisted/default role changes. */
export function withDisplayRole(
  identity: ServerEffectiveIdentity,
  role: string | undefined,
): ServerEffectiveIdentity {
  return role && (TRIAGE_ROLES as readonly string[]).includes(role)
    ? { ...identity, role: role as TriageRole, roleSource: "explicit" }
    : identity;
}

/** Existing selection fields describe display focus, never trusted execution authority. */
export function effectiveReadIdentity(
  effective: EffectiveIdentity,
  explicitSource: "startup" | "tool" = "startup",
): ReadIdentity {
  return {
    agent: effective.agent,
    source:
      effective.source === "explicit-agent"
        ? explicitSource
        : effective.source === "binding"
          ? "environment"
          : effective.source,
    entry: effective.entry,
    triageRole: effective.triageRole,
    diagnostic: effective.diagnostic
      ? `${effective.diagnostic.message} ${effective.diagnostic.recovery}`
      : null,
    store: effective.store === "none" ? null : effective.store,
    storeDiagnostic: null,
  };
}
