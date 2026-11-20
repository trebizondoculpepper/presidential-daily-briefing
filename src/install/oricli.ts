/**
 * `pdb install ori` / `pdb uninstall ori` command surface (#772).
 *
 * Contract: doc/design/attended-installer-delivery.md ("Native adapter targets and evidence":
 * Ori project `.ori/mcp.json` MCP entry using the recorded `mcpServers` shape; explicit native
 * user scope only after format verification) and doc/reports/agent-platforms/ori-mcp-acceptance.md.
 * Default scope is the current repository (project `.ori/mcp.json`); `--global` targets the
 * user-wide `.ori/mcp.json` under the native home directory. Identity is resolved/recovered
 * through the existing `pdb setup identity` service for project scope. Ori records no native
 * Stop hook: none is invented or fabricated here (attended-installer-delivery.md).
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { ConfigError, nodeFileSystem, type GitRunner } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { prepareEffectiveIdentity } from "../config/effectiveidentity.js";
import type { EffectiveHuman } from "../config/effectiveidentity.js";
import { resolveEntry } from "../config/harness.js";
import { IDENTITY_FILE, readIdentity } from "../config/identity.js";
import { createGitService, type GitService } from "../git/service.js";
import {
  manifestPath,
  resolveProjectGitCommonDir,
  type InstallScope,
  type InstallEditErrorCode,
  type InstallEditOutcome,
  type InstallItemKind,
} from "./manifest.js";
import {
  installOriMcp,
  oriInstallSnapshotChanged,
  oriMcpTargetPath,
  readOriInstallSnapshot,
  resolveInstalledOriMcp,
  uninstallOriMcp,
  type OriInstallSnapshot,
} from "./orimcp.js";

/** A registered installer client; only Ori is implemented by this module. */
export type OriInstallClient = "ori";

export type OriInstallErrorCode =
  | InstallEditErrorCode
  | "NO_PROJECT"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_AMBIGUOUS"
  | "UNSUPPORTED_SCOPE"
  | "UNSUPPORTED_CLIENT_VERSION"
  | "LOCKED";

/** Installer item kinds: the managed native entries plus the identity preparation outcome. */
export type OriInstallItemKind = InstallItemKind | "identity";

export type OriInstallItemAction = "create" | "replace" | "remove" | "kept" | "absent" | "skipped";
export type OriInstallItemOutcome = InstallEditOutcome | "not-attempted";

export interface OriInstallItem {
  kind: OriInstallItemKind;
  file: string | null;
  action: OriInstallItemAction;
  outcome: OriInstallItemOutcome;
  code: OriInstallErrorCode | null;
  message: string;
  diff: string | null;
  retry: string | null;
}

/** The installer scope, with `repository` carried on the project variant for reporting. */
export type OriInstallScope =
  | (Extract<InstallScope, { kind: "project" }> & { repository: string })
  | Extract<InstallScope, { kind: "global" }>;

export interface OriInstallResult {
  schemaVersion: 1;
  kind: "install-result";
  client: OriInstallClient;
  operation: "install" | "uninstall";
  scope: OriInstallScope;
  dryRun: boolean;
  items: OriInstallItem[];
  status: {
    configured: boolean;
    trusted: "unknown";
    executed: "unknown";
    receiptVerified: "unknown";
  };
  next: string[];
}

export interface OriInstallArguments {
  client: OriInstallClient;
  operation: "install" | "uninstall";
  global: boolean;
  transport: "stdio" | "http";
  url: string | null;
  role: string | null;
  entry: string | null;
  harness: string | null;
  repo: string | null;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  /** Adopting a foreign PDB entry is explicit (owned-only replacement exception). */
  adopt: boolean;
  help: boolean;
}

/** The supported Ori installer flags (attended-installer-delivery.md CLI shape). */
export function oriInstallArgumentsFor(
  args: string[],
  operation: "install" | "uninstall",
): OriInstallArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      global: { type: "boolean" },
      transport: { type: "string" },
      url: { type: "string" },
      role: { type: "string" },
      entry: { type: "string" },
      harness: { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      adopt: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const client = (positionals[0] ?? "ori") as OriInstallClient;
  if (client !== "ori")
    throw new Error(`Unsupported installer client ${JSON.stringify(client)}; supported: ori.`);
  if (values.transport !== undefined && values.transport !== "stdio" && values.transport !== "http")
    throw new Error("--transport must be stdio or http.");
  if (values.transport === "http" && operation === "uninstall")
    throw new Error("--transport applies to install only; uninstall removes whatever is owned.");
  if (values.url !== undefined && values.transport !== "http")
    throw new Error("--url requires --transport http.");
  if (values.url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(values.url);
    } catch {
      throw new Error("--url must be a valid http(s) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("--url must use http or https.");
    }
    if (!parsed.hostname) throw new Error("--url must include a host.");
    values.url = parsed.toString();
  }
  if (values.entry !== undefined && values.harness !== undefined)
    throw new Error("Give --entry or --harness, not both.");
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.role !== undefined && values.role !== "implementer" && values.role !== "designer")
    throw new Error("--role must be implementer or designer.");
  return {
    client,
    operation,
    global: values.global === true,
    transport: values.transport === "http" ? "http" : "stdio",
    url: values.url ?? null,
    role: values.role ?? null,
    entry: values.entry ?? null,
    harness: values.harness ?? null,
    repo: values.repo ?? null,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    yes: values.yes === true,
    adopt: values.adopt === true,
    help: values.help === true,
  };
}

export const oriInstallHelp = (operation: "install" | "uninstall"): string =>
  operation === "install"
    ? `Usage: pdb install ori [--global] [--role implementer|designer]
                      [--entry KEY | --harness NAME] [--repo owner/name] [--adopt] [--dry-run] [--json] [--yes]
Configure the PDB MCP connection for Ori. Default scope is the current repository (project
.ori/mcp.json); --global targets the user-wide .ori/mcp.json under your home directory. STDIO is
the current transport (HTTP MCP is not a verified Ori integration). --dry-run previews exact
changes and writes nothing. Ori MCP servers from a project .ori/mcp.json start only after you
approve them in an attended run (ori-mcp-acceptance.md). Ori records no native Stop hook, so none
is installed.`
    : `Usage: pdb uninstall ori [--global] [--dry-run] [--json] [--yes]
Remove only PDB-managed Ori entries in the selected scope; identity, project settings and
unrelated entries survive. Already absent is a no-op. --global is required to touch user-wide
entries.`;

function resolveHome(path: string, homeDir: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homeDir);
  return path;
}

/** The typed Git service over the injected runner (or the node default when absent). */
function gitService(git: GitRunner | undefined): GitService {
  return createGitService(git === undefined ? {} : { git });
}

export interface OriIdentityOutcome {
  entry: string | null;
  planned?: boolean;
  created: boolean;
  refused: string | null;
  retry: string | null;
}

/**
 * Resolve the per-repository identity for a project install via the shared `resolveEntry` and the
 * identity file (ori-mcp-acceptance.md: Ori uses `--project`/`--repo` and returns the client-name
 * identity). Global scope and uninstall never invent an identity; a non-interactive install
 * without an explicit --entry/--harness refuses rather than guessing.
 */
async function prepareIdentity(
  args: OriInstallArguments,
  scope: OriInstallScope,
  runtime: OriRunRuntime,
  dryRun: boolean,
): Promise<OriIdentityOutcome> {
  if (args.operation !== "install" || scope.kind !== "project")
    return { entry: null, created: false, refused: null, retry: null };
  const fs = runtime.fs ?? nodeFileSystem;
  const env = runtime.env ?? process.env;
  let targetEntry = args.entry ?? undefined;
  if (targetEntry === undefined) {
    let resolution;
    try {
      resolution = await resolveEntry({
        harness: args.harness ?? "ori",
        env,
        root: scope.root,
        fs: fs ?? undefined,
      });
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { entry: null, created: false, refused: message, retry: null };
    }
    if (resolution.status === "unresolved") {
      return {
        entry: null,
        created: false,
        refused: `${resolution.message} No identity was borrowed: the Ori install resolves the Ori entry.`,
        retry: `pdb config set identity.triage_role implementer --entry ori --repo ${scope.repository}`,
      };
    }
    targetEntry = resolution.entry;
  }
  // With an explicit --role, reuse the shared identity setup so a fresh checkout can initialize
  // the entry (attended-installer-delivery.md "reuse shared identity resolution/allocation", as
  // the Codex/Claude installers do); a read-only install without a role only reads the record.
  if (args.role !== null && args.role !== undefined) {
    const prepared = await prepareEffectiveIdentity(
      {
        project: scope.root,
        repository: scope.repository,
        entry: targetEntry,
        role: args.role,
        // Read-only previews must never write: a fresh checkout's identity is planned, not
        // persisted, until the user approves (attended-installer read-only preview contract).
        intent: dryRun ? "dry-run" : "normal",
      },
      {
        cwd: scope.root,
        env: {},
        fs,
        git: runtime.git,
        random: runtime.random,
        human: async (): Promise<EffectiveHuman> => ({
          context: {
            state: "unresolved",
            host: "github.com",
            login: null,
            source: "none",
            reason: "Installer identity preparation",
          },
          authenticationFailed: false,
        }),
      },
    );
    // An unresolved or failed identity preparation (nothing persisted) must refuse with recovery;
    // a proposed (dry-run creation) result is planned, not kept (reviewed #1150 finding).
    if (prepared.state === "unresolved" || prepared.state === "failed") {
      if (prepared.setup.state === "persisted-with-error") {
        // The identity write actually completed before a later step failed: report the outcome.
        return {
          entry: prepared.entry,
          created: false,
          refused:
            prepared.setup.notices.join("; ") || "The identity was persisted but failed cleanup.",
          retry: identityRecoveryHint(targetEntry, args.role),
        };
      }
      const diagnostic = prepared.diagnostic;
      return {
        entry: null,
        created: false,
        refused:
          diagnostic?.code === "identity-unresolved" || diagnostic?.code === "invalid-value"
            ? diagnostic.message
            : (diagnostic?.message ?? "IDENTITY_REQUIRED: identity could not be prepared."),
        retry: diagnostic?.recovery ?? null,
      };
    }
    if (prepared.state === "proposed") {
      return {
        entry: prepared.entry,
        planned: true,
        created: false,
        refused: null,
        retry: prepared.diagnostic?.recovery ?? null,
      };
    }
    // A true setup failure means nothing was written: refuse with recovery.
    if (prepared.setup.state === "failed") {
      return {
        entry: null,
        created: false,
        refused: prepared.diagnostic?.message ?? "IDENTITY_REQUIRED",
        retry: prepared.diagnostic?.recovery ?? null,
      };
    }
    return {
      entry: prepared.entry,
      created: prepared.setup.state === "created" || prepared.setup.state === "imported",
      refused:
        prepared.setup.state === "persisted-with-error"
          ? prepared.setup.notices.join("; ") || "The identity was persisted but failed cleanup."
          : null,
      retry:
        prepared.setup.state === "persisted-with-error"
          ? identityRecoveryHint(targetEntry, args.role)
          : null,
    };
  }
  // Read-only: reuse the recorded identity entry; refuse when it does not exist or has no name,
  // so the MCP entry is not written pointing at an identity that cannot resolve.
  try {
    const record = await readIdentity(scope.root, targetEntry, fs ?? nodeFileSystem);
    if (record.name === null) {
      const why = !record.fileExists
        ? `There is no ${IDENTITY_FILE} at the project root.`
        : !record.entryExists
          ? `${IDENTITY_FILE} has no [agents.${targetEntry}] entry.`
          : `[agents.${targetEntry}] has no valid name.`;
      const detail = [...record.problems, why].join(" ");
      return {
        entry: targetEntry,
        created: false,
        refused: detail,
        retry: `pdb config set identity.name NAME --entry ${targetEntry}`,
      };
    }
    return {
      entry: targetEntry,
      created: false,
      refused: null,
      retry: null,
    };
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { entry: null, created: false, refused: message, retry: null };
  }
}

/** Resolve the installer scope: project root (default) or user-wide Ori config (--global). */
export async function resolveOriInstallScope(
  args: OriInstallArguments,
  runtime: ConfigRuntime,
): Promise<OriInstallScope> {
  if (args.global) {
    const homeDir = process.env.HOME ?? homedir();
    const home = resolveHome(process.env.ORI_CONFIG_DIR?.trim() ?? "", homeDir) || homeDir;
    // The user-wide Ori config lives under the native home (no invented sub-path); an explicit
    // ORI_CONFIG_DIR selects it explicitly (format must be verified before user writes).
    return { kind: "global", stateDir: home, homeDir: home };
  }
  try {
    const git = runtime.git;
    const cwd = runtime.cwd ?? process.cwd();
    const root = await gitService(git).workingTreeRoot({ cwd });
    if (!root) throw new Error("NO_PROJECT: no Git working-tree root.");
    // Route every Git fact through the typed service so GIT_DIR/GIT_WORK_TREE cannot point at an
    // unrelated checkout. A requested --repo must match the checkout's GitHub remotes (codex
    // installer convention); without one the single trusted remote derives it.
    let repository: string | null = null;
    if (args.repo !== null && args.repo !== undefined) {
      const remotes = await gitService(git).remotes({ cwd: root });
      const requested = args.repo.toLowerCase();
      const repositories = [
        ...new Set(remotes.map((r) => r.repository).filter((r): r is string => r !== null)),
      ];
      if (!repositories.includes(requested))
        throw new Error(
          `NO_PROJECT: the checkout is not ${args.repo} (GitHub remotes: ${repositories.join(", ") || "none"}).`,
        );
      repository = requested;
    } else {
      const identity = await gitService(git).checkout({ cwd: root });
      repository = identity ? identity.repository : null;
    }
    if (!repository)
      throw new Error(
        "NO_PROJECT: the repository could not be resolved; run from a checkout with a single GitHub remote or pass --repo owner/name.",
      );
    const gitCommonDir = await resolveProjectGitCommonDir(root, git);
    return { kind: "project", root, repository, gitCommonDir };
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`NO_PROJECT: ${error.message}`);
    throw error;
  }
}

export interface OriRunRuntime extends ConfigRuntime {
  confirm?: (prompt: string) => Promise<boolean>;
  stderr?: (text: string) => void | Promise<void>;
  /** Inject the installed pdb-mcp path for tests; resolves from the running package when omitted. */
  pdbMcpPath?: string;
}

/**
 * The recovery hint for an entry whose identity was written but whose setup then failed. The
 * requested role is preserved: telling a `--role designer` caller to record `implementer` would
 * undo the role it asked for (#1150 review).
 */
export function identityRecoveryHint(entry: string, role: string | null): string {
  return `pdb config set identity.triage_role ${role ?? "implementer"} --entry ${entry}`;
}

function formatOriInstallOutput(
  result: OriInstallResult,
  scope: OriInstallScope,
  operation: OriInstallArguments["operation"],
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2) + "\n";
  return `pdb ${operation} ori\nScope: ${scope.kind === "project" ? `project ${scope.repository} at ${scope.root}` : `global ${scope.homeDir}`}\nItems:\n${result.items
    .map(
      (i) =>
        `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}${i.diff ? `\n${i.diff.trimEnd()}` : ""}${i.retry ? `\n    retry: ${i.retry}` : ""}`,
    )
    .join("\n")}\nNext:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`;
}

async function evaluateOriInstallPlan(params: {
  args: OriInstallArguments;
  scope: OriInstallScope;
  manifestPathForScope: string;
  runtime: OriRunRuntime;
  dryRun: boolean;
  expectedSnapshot?: OriInstallSnapshot;
}): Promise<{ result: OriInstallResult; exitCode: number }> {
  const { args, scope, manifestPathForScope, runtime, dryRun, expectedSnapshot } = params;
  const mcpFile = oriMcpTargetPath(scope);
  // A STDIO install needs the installed pdb-mcp command; refusing here avoids writing a command
  // that cannot run (attended-installer-delivery.md "never a checkout or .mjs helper").
  const pdbMcp =
    args.operation === "install" && args.transport === "stdio"
      ? (runtime.pdbMcpPath ?? (await resolveInstalledOriMcp()))
      : null;
  // A STDIO entry uses a packaged pdb-mcp path; from a source checkout none can be resolved, so
  // neither a plan nor an apply should present a command that cannot run (attended-installer
  // "never a checkout or .mjs helper"). Refusing in dry-run too keeps previews truthful.
  if (args.operation === "install" && args.transport === "stdio" && !pdbMcp) {
    const refused: OriInstallResult = {
      schemaVersion: 1,
      kind: "install-result",
      client: args.client,
      operation: args.operation,
      scope,
      dryRun,
      items: [
        {
          kind: "mcp",
          file: mcpFile,
          action: "kept",
          outcome: "refused",
          code: "UNSUPPORTED_SCOPE",
          message:
            "The running PDB is not an npm installation, so the installed pdb-mcp command cannot be resolved; refusing to write an entry that cannot run.",
          diff: null,
          retry: `pdb install ori${args.global ? " --global" : ""}${args.repo ? ` --repo ${args.repo}` : ""}`,
        },
      ],
      status: {
        configured: false,
        trusted: "unknown",
        executed: "unknown",
        receiptVerified: "unknown",
      },
      next: ["Install or update PDB via npm, then re-run."],
    };
    return { result: refused, exitCode: 2 };
  }
  const conflicted =
    !dryRun &&
    expectedSnapshot &&
    oriInstallSnapshotChanged(
      expectedSnapshot,
      await readOriInstallSnapshot(scope, manifestPathForScope),
    );
  // Resolve the per-repository identity before writing the project MCP entry; a refusal is an
  // explicit partial outcome, never silently swallowed.
  const identity = conflicted
    ? { entry: null, created: false, refused: null, retry: null }
    : await prepareIdentity(args, scope, runtime, dryRun);
  const identityEntry = identity.entry;
  let identityItem: OriInstallItem | null = null;
  if (identity.refused !== null) {
    identityItem = {
      kind: "identity",
      file: null,
      action: "kept",
      outcome: "refused",
      code: "IDENTITY_REQUIRED",
      message: identity.refused,
      diff: null,
      retry: identity.retry,
    };
  }
  const identityBlocked = identityItem?.outcome === "refused";
  const performed = conflicted
    ? {
        mcp: {
          action: "kept" as const,
          outcome: "refused" as const,
          ownership: "absent" as const,
          code: "CONFLICT" as const,
          message:
            "Ori configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      }
    : identityBlocked && scope.kind === "project" && args.operation === "install"
      ? {
          mcp: {
            action: "kept" as const,
            outcome: "not-attempted" as const,
            ownership: "absent" as const,
            code: "IDENTITY_REQUIRED" as const,
            message:
              "MCP registration withheld: the Ori identity could not be resolved; fix identity and re-run.",
            diff: null,
            manifestRecord: null,
          },
        }
      : args.operation === "install"
        ? await installOriMcp({
            scope,
            options: {
              transport: args.transport,
              url: args.url,
              entry: identityEntry ?? args.entry,
              projectRoot: scope.kind === "project" ? scope.root : undefined,
              repository: scope.kind === "project" ? scope.repository : undefined,
            },
            manifestPath: manifestPathForScope,
            pdbVersion: "0.1.0",
            dryRun,
            adopt: args.adopt,
            pdbMcp: runtime.pdbMcpPath ?? undefined,
            expectedSnapshot,
          })
        : await uninstallOriMcp({
            scope,
            manifestPath: manifestPathForScope,
            dryRun,
            expectedSnapshot,
          });
  const mcp = performed.mcp;
  const mcpConfigured =
    args.operation === "install" &&
    !dryRun &&
    (mcp.outcome === "applied" || mcp.outcome === "kept" || mcp.outcome === "committed-with-error");
  const items: OriInstallItem[] = [
    ...(identityItem
      ? [identityItem]
      : identityEntry && scope.kind === "project" && args.operation === "install"
        ? [
            {
              kind: "identity" as const,
              file: null,
              action: "kept" as const,
              outcome:
                identity.planned === true
                  ? ("planned" as const)
                  : identity.created === true
                    ? ("applied" as const)
                    : ("kept" as const),
              code: null,
              message: identity.planned
                ? `Would configure [agents.${identityEntry}] in pdb.toml with role ${args.role}.`
                : identity.created
                  ? `Setup/reused identity entry [agents.${identityEntry}] for this repository.`
                  : `Using identity entry [agents.${identityEntry}] for this repository.`,
              diff: null,
              retry: null,
            },
          ]
        : []),
    {
      kind: "mcp",
      file: mcpFile,
      action: mcp.action,
      outcome: mcp.outcome,
      code: mcp.code,
      message: mcp.message,
      diff: mcp.diff,
      retry:
        mcp.outcome === "refused"
          ? `pdb ${args.operation} ori${args.global ? " --global" : ""}${args.repo ? ` --repo ${args.repo}` : ""} --yes`
          : null,
    },
  ];
  const result: OriInstallResult = {
    schemaVersion: 1,
    kind: "install-result",
    client: args.client,
    operation: args.operation,
    scope,
    dryRun,
    items,
    status: {
      configured: mcpConfigured,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    },
    next: [
      mcp.outcome === "applied" || mcp.outcome === "kept" || mcp.outcome === "committed-with-error"
        ? args.operation === "install"
          ? scope.kind === "project"
            ? "Configured the Ori MCP server for this project (STDIO)."
            : "Configured the Ori MCP server in your user-wide .ori/mcp.json."
          : "Removed the PDB-managed Ori MCP entry in the selected scope."
        : mcp.outcome === "refused"
          ? `The Ori MCP entry was not written: ${mcp.code ?? "refused"}. Fix the reported issue and re-run.`
          : "",
      dryRun ? "Dry run: remove --dry-run (or confirm) to write." : "",
      args.operation === "install" &&
      (mcp.outcome === "applied" ||
        mcp.outcome === "kept" ||
        mcp.outcome === "committed-with-error")
        ? "Approve the PDB MCP server in an attended Ori run before it starts (ori-mcp-acceptance.md)."
        : "",
    ].filter(Boolean),
  };
  const refusedOrFailed = result.items.some(
    (i) =>
      i.outcome === "refused" ||
      i.outcome === "failed" ||
      i.outcome === "committed-with-error" ||
      i.code === "IDENTITY_REQUIRED",
  );
  const appliedOrCurrent = result.items.some(
    (i) => i.outcome === "applied" || i.outcome === "kept" || i.outcome === "adopted",
  );
  // The effective dry run decides the exit code, not the requested flag: the confirmation
  // contract previews a non-TTY invocation without --yes, and a complete preview is not a miss
  // (#1150 review). A planned-only preview therefore exits 0.
  const exitCode = refusedOrFailed ? 2 : !appliedOrCurrent && !dryRun ? 1 : 0;
  return { result, exitCode };
}

/**
 * Run `pdb install ori` / `pdb uninstall ori`. Identity is resolved for project scope (never
 * invented for --global); the MCP item uses the shared owned-entry manifest. No Stop hook exists
 * for Ori and none is fabricated.
 */
export async function runOriInstall(
  args: OriInstallArguments,
  runtime: OriRunRuntime,
  output: (text: string) => Promise<void>,
): Promise<number> {
  const scope = await resolveOriInstallScope(args, runtime);
  const manifestPathForScope = manifestPath(scope, "ori");
  if (args.operation === "install" && args.transport === "http") {
    const refused: OriInstallResult = {
      schemaVersion: 1,
      kind: "install-result",
      client: args.client,
      operation: args.operation,
      scope,
      dryRun: true,
      items: [
        {
          kind: "mcp",
          file: oriMcpTargetPath(scope),
          action: "kept",
          outcome: "refused",
          code: "UNSUPPORTED_SCOPE",
          message:
            "HTTP MCP transport is not a verified Ori integration (ori-mcp-acceptance.md records only STDIO); use STDIO.",
          diff: null,
          retry: `pdb install ori${args.global ? " --global" : ""}${args.repo ? ` --repo ${args.repo}` : ""}${args.entry ? ` --entry ${args.entry}` : ""}`,
        },
      ],
      status: {
        configured: false,
        trusted: "unknown",
        executed: "unknown",
        receiptVerified: "unknown",
      },
      next: ["Use STDIO (the verified Ori transport): pdb install ori."],
    };
    if (args.json) await output(JSON.stringify(refused, null, 2) + "\n");
    else
      await output(
        `pdb install ori: refused (UNSUPPORTED_SCOPE).\n${refused.items
          .map((i) => `  ${i.kind} (${i.outcome}, ${i.code}): ${i.message}`)
          .join("\n")}\nNext:\n  ${refused.next.join("\n  ")}\n`,
      );
    return 2;
  }
  // Confirmation contract: --dry-run always previews; --yes applies directly; otherwise a TTY
  // shows the read-only preview first and requests confirmation, while a non-TTY without --yes
  // behaves as a dry run (never writes unconfirmed).
  if (args.dryRun || (!args.yes && !runtime.confirm)) {
    const preview = await evaluateOriInstallPlan({
      args,
      scope,
      manifestPathForScope,
      runtime,
      dryRun: true,
    });
    await output(formatOriInstallOutput(preview.result, scope, args.operation, args.json));
    return preview.exitCode;
  }
  let expectedSnapshot: OriInstallSnapshot | undefined;
  if (!args.yes && runtime.confirm) {
    expectedSnapshot = await readOriInstallSnapshot(scope, manifestPathForScope);
    const preview = await evaluateOriInstallPlan({
      args,
      scope,
      manifestPathForScope,
      runtime,
      dryRun: true,
    });
    if (preview.exitCode === 2) {
      await output(formatOriInstallOutput(preview.result, scope, args.operation, args.json));
      return 2;
    }
    const previewText = formatOriInstallOutput(preview.result, scope, args.operation, false);
    // In JSON mode the human-readable preview belongs on stderr so stdout stays parseable JSON
    // (Codex installer convention; a declined interactive confirm still emits only the JSON result).
    if (!args.json) await output(previewText);
    else if (runtime.stderr) await runtime.stderr(previewText);
    else process.stderr.write(previewText);
    const approved = await runtime.confirm(
      `Apply pdb ${args.operation} ori in ${scope.kind === "project" ? scope.root : scope.homeDir}?`,
    );
    if (!approved) {
      if (args.json) {
        await output(formatOriInstallOutput(preview.result, scope, args.operation, true));
      }
      return preview.exitCode;
    }
  }
  const applied = await evaluateOriInstallPlan({
    args,
    scope,
    manifestPathForScope,
    runtime,
    dryRun: false,
    expectedSnapshot,
  });
  await output(formatOriInstallOutput(applied.result, scope, args.operation, args.json));
  return applied.exitCode;
}
