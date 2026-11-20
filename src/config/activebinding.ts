/**
 * Registered local execution bindings (#677, doc/design/effective-identity.md).
 * Source evidence: doc/reports/agent-platforms/codex-thread-binding.md.
 * Correlation facts select a local entry; they never authenticate a caller or grant permission.
 */
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { detectHarness, HARNESS_DETECTORS, type Environment, type HarnessId } from "./harness.js";

interface BindingProvider {
  readonly id: string;
  readonly harness: HarnessId;
  readonly signal: string;
  readonly supportingSignals: readonly string[];
  readonly supported: (env: Environment) => boolean;
}

/** No guessed fallback for another harness, an old executor or a shared root session. */
export const ACTIVE_BINDING_PROVIDERS = [
  {
    id: "codex-thread",
    harness: "codex",
    signal: "CODEX_THREAD_ID",
    supportingSignals: ["CODEX_VERSION"],
    supported: (env: Environment): boolean => {
      const version = /^(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?$/.exec(env.CODEX_VERSION ?? "");
      if (!version) return false;
      const major = Number(version[1]);
      const minor = Number(version[2]);
      return (
        Number.isSafeInteger(major) && Number.isSafeInteger(minor) && (major > 0 || minor >= 169)
      );
    },
  },
] as const satisfies readonly BindingProvider[];

type Provider = (typeof ACTIVE_BINDING_PROVIDERS)[number];
export interface ActiveBinding {
  readonly provider: Provider["id"];
  readonly harness: Provider["harness"];
  readonly key: string;
  readonly entry: string;
}

/**
 * No raw session/thread value is returned, persisted or used as an entry key. `entry` is the
 * harness's canonical default entry; `key` correlates this session's binding with it.
 */
export function activeBinding(options: {
  env: Environment;
  root: string;
  repository: string;
  platform?: NodeJS.Platform;
}): ActiveBinding | null {
  const detection = detectHarness(options.env);
  if (detection.status !== "detected") return null;
  const provider = ACTIVE_BINDING_PROVIDERS.find((p) => p.harness === detection.harness);
  if (!provider || !provider.supported(options.env)) return null;
  const thread = options.env[provider.signal];
  if (!thread || !/^[A-Za-z0-9_.:-]{1,256}$/.test(thread)) return null;
  const platform = options.platform ?? process.platform;
  const root =
    platform === "win32" ? win32.resolve(options.root).toLowerCase() : posix.resolve(options.root);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        provider: provider.id,
        root,
        repository: options.repository.toLowerCase(),
        thread,
      }),
    )
    .digest("hex");
  return {
    provider: provider.id,
    harness: provider.harness,
    key: `${provider.id}_${digest}`,
    // #1047 (doc/design/stable-harness-identity.md): one persistent default per harness; the
    // session digest only correlates this session with it and is never an entry key.
    entry: provider.harness,
  };
}

/** Snapshot only registered correlation inputs for a local server's fixed execution session. */
export function captureBindingEnvironment(env: Environment): Environment {
  const names = new Set([
    ...HARNESS_DETECTORS.flatMap((provider) => provider.environment),
    ...ACTIVE_BINDING_PROVIDERS.flatMap((provider) => [
      provider.signal,
      ...provider.supportingSignals,
    ]),
  ]);
  return Object.fromEntries([...names].map((name) => [name, env[name]]));
}
