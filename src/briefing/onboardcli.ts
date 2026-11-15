/**
 * `pdb onboard` (#351, doc/design/agent-onboarding.md "CLI"). Read-only by default: it renders
 * the onboarding document and writes nothing. The project comes from `--repo` or this checkout's
 * verified remote, never from a GitHub scan; outside a checkout it renders the generic document
 * with a project-selection hint. `--install` writes the managed AGENTS.md section of the verified
 * matching checkout only. Works without credentials. Exit 0 rendered/unchanged/installed, 2 usage
 * or unresolved project prerequisites, 1 failed install.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveRepositoryTarget } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { installCoordinationSection } from "../config/agentsguide.js";
import { updateJsonFile, type SafeFs } from "../config/safejson.js";
import { defaultCacheDir } from "../updates/updatecache.js";
import { onboardingDocument, onboardingText, validServerOrigin } from "./onboarding.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const onboardUsage =
  "Usage: pdb onboard [--repo owner/name] [--role implementer|designer] [--server URL] [--install] [--json]";

export async function runOnboard(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: ConfigRuntime = {},
  stderr: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<number> {
  let values: {
    repo?: string;
    role?: string;
    server?: string;
    install?: boolean;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        role: { type: "string" },
        server: { type: "string" },
        install: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    stderr(`pdb onboard: ${(error as Error).message}\n${onboardUsage}\n`);
    return 2;
  }
  if (values.help) {
    await output(
      `${onboardUsage}\n\nPrints how an agent gets started with pdb in this project: the rules, its own identity, the commands and a prompt to give it. --install adds or updates the pdb coordination section of this checkout's AGENTS.md (nothing else is changed).\n`,
    );
    return 0;
  }
  const usage = (message: string) => {
    stderr(`pdb onboard: ${message}\n${onboardUsage}\n`);
    return 2;
  };
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    return usage("--repo must be owner/name.");
  if (values.role !== undefined && values.role !== "implementer" && values.role !== "designer")
    return usage("--role must be implementer or designer.");
  const server = values.server === undefined ? null : validServerOrigin(values.server);
  if (values.server !== undefined && !server)
    return usage("--server must be an http(s) origin without credentials, path or query.");

  // The project: explicit, or this checkout's verified remote. Never a GitHub scan.
  let repository = values.repo ?? null;
  let root: string | null = null;
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      values.repo,
      runtime.git,
    );
    repository = target.repository;
    root = target.root;
  } catch {
    // No matching checkout: read-only instructions still work for an explicit or no project.
  }
  const doc = onboardingDocument({
    repository,
    ...(values.role ? { role: values.role as "implementer" | "designer" } : {}),
    server,
  });

  let install: Awaited<ReturnType<typeof installCoordinationSection>> | null = null;
  if (values.install) {
    if (!root || !repository)
      return usage(
        values.repo
          ? `--install needs a local checkout of ${values.repo}; run it from that checkout.`
          : "--install needs a local GitHub checkout; run it from the project, or pass --repo from its checkout.",
      );
    install = await installCoordinationSection(root, doc.persistentSection);
  }
  const code = install && install.status !== "written" && install.status !== "kept" ? 1 : 0;
  if (values.json) {
    await output(
      JSON.stringify(
        {
          ...doc,
          ...(install
            ? {
                install: {
                  status: install.status,
                  file: install.file,
                  ...("reason" in install ? { reason: install.reason } : {}),
                  cleanup: install.cleanup,
                },
              }
            : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return code;
  }
  await output(onboardingText(doc));
  if (install) {
    const line =
      install.status === "written"
        ? `Added the pdb coordination section to ${install.file} (a local change: commit it with your work).`
        : install.status === "kept"
          ? `${install.file} already has the current pdb coordination section; nothing was changed.`
          : install.status === "committed-with-error"
            ? `Updated ${install.file}, but ${install.reason}.`
            : `Did not change ${install.file ?? "AGENTS.md"}: ${install.reason}.`;
    stderr(`pdb: ${line}\n`);
    for (const note of install.cleanup) stderr(`pdb: ${note}\n`);
  }
  return code;
}

/** The first-use hint line (one short stderr pointer). */
export const firstUseHintText =
  "pdb: new to pdb in this project? `pdb onboard` shows the rules, identity setup and a prompt for agents.";

export const hintFileName = "onboarding-hints.json";
/** Set to any value to never show (or record) the first-use hint. */
export const firstUseHintOptOutEnv = "PDB_NO_FIRST_USE_HINT";
const hintLimit = 200;

/**
 * Whether to show the first-use hint for this project and CLI version, recording that it was
 * shown (#351). At most once per project/version per user; any cache problem means no hint, and
 * never a failed briefing.
 */
export async function firstUseHint(
  project: string,
  version: string,
  options: { cacheDir?: string; fs?: SafeFs; lockWaitMs?: number } = {},
): Promise<boolean> {
  const key = `${project}@${version}`;
  try {
    const outcome = await updateJsonFile(
      join(options.cacheDir ?? defaultCacheDir(), hintFileName),
      (current) => {
        if (current.state === "unreadable") return { refuse: "unreadable hint cache" };
        const value = current.state === "value" ? current.value : null;
        const seen =
          isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.shown)
            ? value.shown.filter((k): k is string => typeof k === "string")
            : [];
        if (seen.includes(key)) return { keep: "already shown" };
        return { write: { schemaVersion: 1, shown: [...seen, key].slice(-hintLimit) } };
      },
      { lockWaitMs: options.lockWaitMs ?? 250, ...(options.fs ? { fs: options.fs } : {}) },
    );
    return outcome.status === "written";
  } catch {
    return false;
  }
}
