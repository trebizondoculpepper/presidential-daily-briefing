/** Repository-scoped engine selection; importing this never initializes DataScript. */
import {
  ConfigError,
  loadConfig,
  retiredKeyNotices,
  resolveRepositoryTarget,
  nodeFileSystem,
} from "./config.js";
import type { GuideRuntime } from "../briefing/process.js";
export type EngineName = "typescript" | "datalog";
/** #1050: the native policy is the only next-action scheduler; there is no engine selector. */
export const defaultEngine = (): EngineName => "datalog";
export interface EngineSetting {
  requested: EngineName;
  source: "config" | "default" | "no-matching-project";
  /** #1050: diagnostics for a stored retired engine key, with its safe removal. */
  obsolete?: string[];
}
export class BriefingEngineError extends Error {
  constructor(
    readonly code: "decision-engine-config" | "decision-engine-role" | "decision-engine-failed",
    detail: string,
    recovery = "No other scheduler was run; pdb doctor checks the engine's dependencies.",
    /** #346: a typed cause for `decision-engine-failed`, from structured error evidence only. */
    readonly engineCause?: EngineFailureCause,
  ) {
    super(`${detail} ${recovery}`);
  }
}

/** Why the Datalog engine failed, where the error's own fields prove it (#346, #1132). */
export type EngineFailureCause =
  | { category: "missing-module"; module: string | null }
  /** #1132: a documented capacity bound, not a broken installation. */
  | { category: "scope-limit"; limit: number | null; unit: "subjects" | "datoms" | null }
  | { category: "unknown" };

/** Safe, bounded cause for API and MCP error bodies: validated fields only, no message text. */
export type SafeEngineCause =
  | {
      category: "missing-module";
      /** A validated package specifier, or null when the name could not be shown safely. */
      module: string | null;
      /** Delivered recovery commands. */
      recovery: string[];
    }
  | {
      category: "scope-limit";
      /** The supported bound, or null when the engine's message did not state one. */
      limit: number | null;
      unit: "subjects" | "datoms" | null;
      /** Delivered recovery commands. */
      recovery: string[];
    };

export const missingModuleRecovery = ["npm ci", "pdb doctor"];

/**
 * How to stay inside the engine's experimental subject/datom bound (#1132). Only an
 * issue-focused read reduces the subjects the engine evaluates: `--limit` is applied after
 * evaluation and `--since` keeps the complete open inventory (review finding on #1182).
 */
export const scopeLimitRecovery = ["pdb --issue N"];

/** The structured cause of an engine failure, or null when the evidence does not prove one. */
export function safeEngineCause(error: unknown): SafeEngineCause | null {
  if (!(error instanceof BriefingEngineError)) return null;
  const cause = error.engineCause;
  if (cause?.category === "missing-module") {
    const module =
      cause.module !== null && cause.module.length <= 214 && packageSpecifier.test(cause.module)
        ? cause.module
        : null;
    return { category: "missing-module", module, recovery: [...missingModuleRecovery] };
  }
  if (cause?.category === "scope-limit")
    return {
      category: "scope-limit",
      limit: cause.limit,
      unit: cause.unit,
      recovery: [...scopeLimitRecovery],
    };
  return null;
}

/** One sentence naming the cause, built only from the safe fields. */
export const safeEngineCauseText = (cause: SafeEngineCause) =>
  cause.category === "missing-module"
    ? `Missing module ${cause.module ?? "(name not shown)"}: in a PDB source checkout run npm ci at its root, or reinstall the published package; pdb doctor checks dependencies.`
    : `The Datalog engine supports at most ${cause.limit ?? "its documented number of"} ${cause.unit ?? "subjects"} for one read, and this request exceeded that capacity bound. Narrow it (for example ${cause.recovery.join(", ")}) and retry: this is a capacity limit, not a missing dependency or a broken installation.`;

/** A bare npm package specifier (optionally scoped): never a path. */
const packageSpecifier = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * Classify an engine load/evaluation error. Only Node's module-resolution error codes count as a
 * missing module; its name is reported only when it validates as a package specifier, so no
 * path or arbitrary message text is echoed.
 */
export function engineFailureCause(error: unknown): EngineFailureCause {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "experimental-scope-exceeded") {
    // #1132: the engine's own bound, parsed strictly so no arbitrary message text is echoed.
    const message = error instanceof Error ? error.message : "";
    const parsed = /at most (\d{1,9}) (subjects|datoms) are supported/.exec(message);
    return {
      category: "scope-limit",
      limit: parsed ? Number(parsed[1]) : null,
      unit: parsed ? (parsed[2] as "subjects" | "datoms") : null,
    };
  }
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
  if (cause.category === "scope-limit")
    return new BriefingEngineError(
      "decision-engine-failed",
      `Datalog evaluation stopped at the engine's capacity bound: ${cause.limit ?? "the documented number of"} ${cause.unit ?? "subjects"} at most.`,
      `Narrow it to a single ticket (${scopeLimitRecovery.join(", ")}) and retry; this is a capacity limit, not a missing dependency.`,
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
      runtime.gitService ?? runtime.git,
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
    // #1050: the configuration is still read and validated (a broken file is an error), but no
    // key selects a scheduler. A stored retired briefing.engine key is reported, never applied.
    const config = await loadConfig(target.root, runtime.fs ?? nodeFileSystem);
    const notices = retiredKeyNotices(config).filter((n) => n.key === "briefing.engine");
    return {
      requested: "datalog",
      source: "default",
      ...(notices.length
        ? { obsolete: notices.map((n) => `${n.detail} Remove it: ${n.next}`) }
        : {}),
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
