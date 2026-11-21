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
import type { GitRunner } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { installCoordinationSection, withCoordinationSection } from "../config/agentsguide.js";
import {
  installRulesFile,
  RULES_FILE_NAME,
  rulesFileCaseCollision,
  sealRulesMarkdown,
  withRulesFile,
} from "../config/rulesfile.js";
import { rulesDocument, rulesMarkdownFile } from "../rules/datalog/rules-command.js";
import { declaredRulesContext } from "../rules/declared-context.js";
import { projectRulesContext } from "../rules/project-context.js";
import { readFile, readdir } from "node:fs/promises";
import { updateJsonFile, type SafeFs } from "../config/safejson.js";
import { createGitService } from "../git/service.js";
import type { GitService } from "../git/service.js";
import { defaultCacheDir } from "../updates/updatecache.js";
import { onboardingDocument, onboardingText, validServerOrigin } from "./onboarding.js";

export interface OnboardRuntime extends Omit<ConfigRuntime, "git"> {
  /** Typed Git service (#900), or legacy `GitRunner` during migration. */
  readonly git?: GitService | GitRunner;
  /** Optional typed Git service overriding `git`. */
  readonly gitService?: GitService;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const onboardUsage =
  "Usage: pdb onboard [--repo owner/name] [--role implementer|designer] [--server URL] [--install] [--dry-run] [--json]";

export async function runOnboard(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: OnboardRuntime = {},
  stderr: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<number> {
  let values: {
    repo?: string;
    role?: string;
    server?: string;
    install?: boolean;
    "dry-run"?: boolean;
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
        "dry-run": { type: "boolean" },
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
      `${onboardUsage}\n\nPrints how an agent gets started with pdb in this project: the rules, its own identity, the commands and a prompt to give it. In a verified checkout it also writes rules.md and updates only the pdb coordination section of AGENTS.md; --install is kept as an alias for those same writes and --dry-run previews them without touching any file. --help reads nothing and writes nothing.\n`,
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
    const git = runtime.gitService ?? runtime.git ?? createGitService();
    const target = await resolveRepositoryTarget(runtime.cwd ?? process.cwd(), values.repo, git);
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

  // #1027: a verified checkout now gets both files by default (rules.md plus the managed
  // AGENTS.md section); --install remains an alias for the same writes, and --dry-run previews
  // them without touching the tree. Outside a verified checkout nothing is written.
  const dryRun = values["dry-run"] === true;
  const files: FileReport[] = [];
  let install: Awaited<ReturnType<typeof installCoordinationSection>> | null = null;
  if (root && repository) {
    const markdown = await generatedRulesMarkdown(repository, runtime);
    // Preflight both files before either mutation (reviewed #1195 finding): a known refusal in
    // one file must not leave the other half-installed, and AGENTS.md must never claim a rules
    // snapshot that was not written.
    const plannedRules = await previewRulesFile(root, markdown);
    const plannedAgents = await previewCoordinationSection(root, doc.persistentSection);
    const blocked = plannedRules.status === "not-written" || plannedAgents.status === "not-written";
    if (dryRun || blocked) {
      // Nothing is written when either preflight refuses. The file that refused keeps its reason;
      // the other is reported as not attempted rather than as a preview, so a real run never
      // looks like a plan.
      const blocker = plannedRules.status === "not-written" ? plannedRules : plannedAgents;
      for (const planned of [plannedRules, plannedAgents]) {
        files.push(
          blocked && planned !== blocker && planned.status === "would-write"
            ? {
                file: planned.file,
                status: "not-written",
                reason: `not attempted: ${blocker.file} was not written`,
              }
            : planned,
        );
      }
    } else {
      const rules = await installRulesFile(root, markdown);
      files.push(fileReportOf(rules));
      if (rules.status === "written" || rules.status === "kept") {
        install = await installCoordinationSection(root, doc.persistentSection);
        files.push(fileReportOf(install));
      } else {
        files.push({
          file: plannedAgents.file,
          status: "not-written",
          reason: `skipped because ${RULES_FILE_NAME} was not written`,
        });
      }
    }
  } else if (values.install) {
    return usage(
      values.repo
        ? `--install needs a local checkout of ${values.repo}; run it from that checkout.`
        : "--install needs a local GitHub checkout; run it from the project, or pass --repo from its checkout.",
    );
  }
  const refused = !dryRun && files.some((f) => f.status === "not-written");
  const code = refused ? 1 : 0;
  if (values.json) {
    await output(
      JSON.stringify(
        {
          ...doc,
          files,
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
  for (const file of files) {
    stderr(`pdb: ${fileLine(file, dryRun)}\n`);
    // Cleanup diagnostics (for example a lock that could not be released) are never dropped.
    for (const note of file.notes ?? []) stderr(`pdb: ${note}\n`);
  }
  return code;
}

/** One file's outcome in the onboarding receipt, for a real or a previewed run. */
export interface FileReport {
  file: string;
  /**
   * `committed-with-error` is a real write whose cleanup failed: the file is in place, so it is
   * never reported as `not-written` (reviewed #1195 finding).
   */
  status: "written" | "would-write" | "kept" | "committed-with-error" | "not-written";
  reason?: string;
  /** Cleanup diagnostics from a successful or partial write: never dropped (reviewed #1195). */
  notes?: string[];
}

/** Map a write outcome to the per-file receipt status; partial writes stay partial. */
export function reportStatusFor(status: string): FileReport["status"] {
  return status === "written"
    ? "written"
    : status === "kept"
      ? "kept"
      : status === "committed-with-error"
        ? "committed-with-error"
        : "not-written";
}

/** One write outcome as a per-file receipt, keeping the reason and every cleanup note. */
export function fileReportOf(outcome: {
  file: string | null;
  status: "written" | "kept" | "not-written" | "committed-with-error";
  reason?: string;
  cleanup?: string[];
}): FileReport {
  return {
    file: outcome.file ?? RULES_FILE_NAME,
    status: reportStatusFor(outcome.status),
    ...("reason" in outcome && outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.cleanup?.length ? { notes: [...outcome.cleanup] } : {}),
  };
}

/** The generated rules markdown for a verified project, from the shared English document. */
async function generatedRulesMarkdown(
  repository: string,
  runtime: OnboardRuntime,
): Promise<string> {
  const { project, limits } = await projectRulesContext({
    repository,
    runtime: runtime as Parameters<typeof projectRulesContext>[0] extends { runtime: infer R }
      ? R
      : never,
  });
  const document = rulesDocument({ ...declaredRulesContext(), project }, {}, undefined, limits);
  return sealRulesMarkdown(rulesMarkdownFile(document));
}

/** What `installRulesFile` would do, without writing (#1027 `--dry-run`). */
async function previewRulesFile(root: string, markdown: string): Promise<FileReport> {
  const collision = await rulesFileCaseCollision(root);
  if (collision) return { file: RULES_FILE_NAME, status: "not-written", reason: collision };
  const current = await readTextOrNull(join(root, RULES_FILE_NAME));
  if (current.state === "unreadable")
    return { file: RULES_FILE_NAME, status: "not-written", reason: current.why };
  const next = withRulesFile(current.text, markdown);
  if ("refuse" in next)
    return { file: RULES_FILE_NAME, status: "not-written", reason: next.refuse };
  if ("unchanged" in next) return { file: RULES_FILE_NAME, status: "kept" };
  return { file: RULES_FILE_NAME, status: "would-write" };
}

/** What the managed AGENTS.md install would do, without writing (#1027 `--dry-run`). */
async function previewCoordinationSection(root: string, section: string): Promise<FileReport> {
  const candidates = await readdir(root)
    .then((entries) => entries.filter((n) => n.toLowerCase() === "agents.md"))
    .catch(() => [] as string[]);
  if (candidates.length > 1)
    return {
      file: "AGENTS.md",
      status: "not-written",
      reason: "both agents.md copies exist; keep one, then retry",
    };
  const file = candidates[0] ?? "AGENTS.md";
  const current = await readTextOrNull(join(root, file));
  if (current.state === "unreadable") return { file, status: "not-written", reason: current.why };
  const next = withCoordinationSection(current.text, section);
  if ("refuse" in next)
    return { file, status: "not-written", reason: `${file} was not changed: ${next.refuse}` };
  if ("unchanged" in next) return { file, status: "kept" };
  return { file, status: "would-write" };
}

const readTextOrNull = async (
  path: string,
): Promise<{ state: "text"; text: string | null } | { state: "unreadable"; why: string }> => {
  try {
    return { state: "text", text: await readFile(path, "utf8") };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return { state: "text", text: null };
    return { state: "unreadable", why: `the existing file cannot be read (${String(code)})` };
  }
};

const fileLine = (file: FileReport, dryRun: boolean): string => {
  switch (file.status) {
    case "written":
      return `wrote ${file.file} (a local change: commit it with your work).`;
    case "would-write":
      return dryRun
        ? `dry run: would write ${file.file}.`
        : `wrote ${file.file} (a local change: commit it with your work).`;
    case "kept":
      return `${file.file} is already current; nothing was changed.`;
    default:
      return `did not change ${file.file}${file.reason ? `: ${file.reason}` : ""}.`;
  }
};

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
