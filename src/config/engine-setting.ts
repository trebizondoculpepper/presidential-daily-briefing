/** Repository-scoped engine selection; importing this never initializes DataScript. */
import {
  ConfigError,
  CONFIG_KEYS,
  loadConfig,
  settingFor,
  resolveRepositoryTarget,
  nodeFileSystem,
} from "./config.js";
import type { GuideRuntime } from "../briefing/process.js";
export type EngineName = "typescript" | "datalog";
export const defaultEngine = (): EngineName =>
  CONFIG_KEYS.find((k) => k.key === "briefing.engine")?.defaultValue === "datalog"
    ? "datalog"
    : "typescript";
export interface EngineSetting {
  requested: EngineName;
  source: "config" | "default" | "no-matching-project";
}
export class BriefingEngineError extends Error {
  constructor(
    readonly code: "decision-engine-config" | "decision-engine-role" | "decision-engine-failed",
    detail: string,
    recovery = "Roll back: pdb config set briefing.engine typescript",
    /** #346: a typed cause for `decision-engine-failed`, from structured error evidence only. */
    readonly engineCause?: EngineFailureCause,
  ) {
    super(`${detail} ${recovery}`);
  }
}

/** Why the Datalog engine failed, where the error's own fields prove it (#346). */
export type EngineFailureCause =
  | { category: "missing-module"; module: string | null }
  | { category: "unknown" };

/** Safe, bounded cause for API and MCP error bodies: validated fields only, no message text. */
export interface SafeEngineCause {
  category: "missing-module";
  /** A validated package specifier, or null when the name could not be shown safely. */
  module: string | null;
  /** Delivered recovery commands. */
  recovery: string[];
}

export const missingModuleRecovery = ["npm ci", "pdb doctor"];

/** The structured cause of a missing engine module, or null for any other engine failure. */
export function safeEngineCause(error: unknown): SafeEngineCause | null {
  if (!(error instanceof BriefingEngineError)) return null;
  const cause = error.engineCause;
  if (cause?.category !== "missing-module") return null;
  const module =
    cause.module !== null && cause.module.length <= 214 && packageSpecifier.test(cause.module)
      ? cause.module
      : null;
  return { category: "missing-module", module, recovery: [...missingModuleRecovery] };
}

/** One sentence naming the cause, built only from the safe fields. */
export const safeEngineCauseText = (cause: SafeEngineCause) =>
  `Missing module ${cause.module ?? "(name not shown)"}: in a PDB source checkout run npm ci at its root, or reinstall the published package; pdb doctor checks dependencies.`;

/** A bare npm package specifier (optionally scoped): never a path. */
const packageSpecifier = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * Classify an engine load/evaluation error. Only Node's module-resolution error codes count as a
 * missing module; its name is reported only when it validates as a package specifier, so no
 * path or arbitrary message text is echoed.
 */
export function engineFailureCause(error: unknown): EngineFailureCause {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND")
    return { category: "unknown" };
  const message = error instanceof Error ? error.message : "";
  const named = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1] ?? "";
  // A deep import such as `datascript/x` is reported by its package.
  const parts = named.split("/");
  const pkg = named.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return { category: "missing-module", module: packageSpecifier.test(pkg) ? pkg : null };
}

/**
 * The `decision-engine-failed` error for a thrown engine failure. A missing module names the
 * module and the recovery; anything else keeps the existing message and is never relabelled as
 * dependency corruption.
 */
export function engineFailure(error: unknown, fallback: string): BriefingEngineError {
  const cause = engineFailureCause(error);
  if (cause.category === "missing-module")
    return new BriefingEngineError(
      "decision-engine-failed",
      `The Datalog engine could not be loaded: missing module ${cause.module ?? "(name not shown)"}. No fallback was run.`,
      "In a source checkout run npm ci at its root (then npm run build when running dist), or reinstall the published package; pdb doctor checks dependencies.",
      cause,
    );
  return new BriefingEngineError(
    "decision-engine-failed",
    error instanceof Error ? error.message : fallback,
    undefined,
    cause,
  );
}
export async function resolveEngineSetting(
  repository: string,
  runtime?: GuideRuntime,
): Promise<EngineSetting> {
  if (!runtime) return { requested: defaultEngine(), source: "no-matching-project" };
  let target;
  try {
    target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      // The shared typed Git service (or a legacy runner); none means the service's isolated default.
      runtime.git,
    );
  } catch (error) {
    if (
      error instanceof ConfigError &&
      ["not-a-repository", "repository-mismatch"].includes(error.code)
    )
      return { requested: defaultEngine(), source: "no-matching-project" };
    throw new BriefingEngineError(
      "decision-engine-config",
      "Cannot resolve the selected repository configuration.",
    );
  }
  try {
    const setting = settingFor(
      await loadConfig(target.root, runtime.fs ?? nodeFileSystem),
      "briefing.engine",
    );
    return {
      requested: setting.value === "datalog" ? "datalog" : "typescript",
      source: setting.source === "explicit" ? "config" : "default",
    };
  } catch (error) {
    throw new BriefingEngineError(
      "decision-engine-config",
      "Repository configuration cannot be read or validated; no decision engine was run.",
      error instanceof ConfigError
        ? error.recovery
        : "Fix the repository configuration, then retry.",
    );
  }
}

export interface DecisionEngineMetadata {
  requested: EngineName;
  used: EngineName;
  source: string;
  policyVersion: number | null;
  rulesHash: string | null;
  coverage: object;
  diagnostics: string[];
  role?: { used: string; source: "request" | "default" };
}
