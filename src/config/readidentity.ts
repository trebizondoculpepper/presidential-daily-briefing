/**
 * Read-only agent identity for focused reads (#25, doc/design/mcp.md "Selection and identity").
 *
 * One resolver composes the shared services instead of re-implementing them: the root
 * `pdb.toml` reader with its read-only legacy `agent-inbox.toml` fallback (#70/#319,
 * identity.ts) and verified entry resolution (#38, harness.ts).
 *
 * Precedence, first match wins:
 * 1. an explicit per-call `agent` (MCP tool argument);
 * 2. the startup `--agent`;
 * 3. the persisted `name` of the selected project's `[agents.KEY]` entry, the entry chosen by
 *    `--entry`, else `--harness`, else verified MCP client info (Ori's `ori-SERVER` client name
 *    maps to `ori.SERVER`), else a harness detected from the environment;
 * 4. otherwise unresolved: an unfocused read with a diagnostic, never a guess.
 *
 * Never creates, renames, repairs or writes anything. Every failure (no project, not a
 * checkout, repository mismatch, unreadable or malformed file, ambiguous entry, missing name)
 * stays local to the identity result: missing evidence means unknown identity, not an error.
 * Diagnostics name entry keys and root-relative files only, never paths or other values.
 */

import { ConfigError, nodeFileSystem } from "./config.js";
import type { GitService } from "../git/service.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { detectClientEntry, resolveEntry } from "./harness.js";
import type { Environment } from "./harness.js";
import { IDENTITY_FILE, readIdentity, resolveIdentityTarget } from "./identity.js";
import type { IdentitySource, TriageRole } from "./identity.js";

/** Which input decided the identity. */
export type ReadIdentitySource =
  | "tool"
  | "startup"
  | "entry"
  | "harness"
  | "client"
  | "environment"
  | "unresolved";

export interface ReadIdentity {
  readonly agent: string | null;
  readonly source: ReadIdentitySource;
  /** The `[agents.KEY]` entry consulted, when one was selected. */
  readonly entry: string | null;
  /** Persisted triage_role of that entry (informational; never inferred from `role`). */
  readonly triageRole: TriageRole | null;
  /** Why identity is unresolved, with recovery; null when resolved. */
  readonly diagnostic: string | null;
  /**
   * Which local store supplied a persisted name (#319): `pdb`, or `legacy-not-imported` when
   * it was read from a legacy agent-inbox.toml entry that has not been imported (nothing is
   * imported by a read). Null when no persisted name was used.
   */
  readonly store: Exclude<IdentitySource, "none"> | null;
  /** Non-secret notice about the store, such as how to import a legacy identity; else null. */
  readonly storeDiagnostic: string | null;
}

export interface ReadIdentityOptions {
  readonly toolAgent?: string;
  readonly startupAgent?: string;
  /** Configured local project; without one no local identity file is consulted. */
  readonly project?: string;
  /** Selected repository; must agree with the project's checkout before its file is used. */
  readonly repository?: string;
  readonly entry?: string;
  readonly harness?: string;
  /** Verified MCP clientInfo name from initialization. */
  readonly clientName?: string;
  readonly env: Environment;
  readonly git?: GitService | GitRunner;
  readonly fs?: ConfigFileSystem;
}

const recovery =
  "Pass agent, or start the server with --agent NAME, --entry KEY or --harness NAME; persist a name with pdb config set identity.triage_role ROLE --entry KEY.";

const unresolved = (reason: string, entry: string | null = null): ReadIdentity => ({
  agent: null,
  source: "unresolved",
  entry,
  triageRole: null,
  diagnostic: `${reason} ${recovery}`,
  store: null,
  storeDiagnostic: null,
});

const explicit = (agent: string, source: "tool" | "startup"): ReadIdentity => ({
  agent,
  source,
  entry: null,
  triageRole: null,
  diagnostic: null,
  store: null,
  storeDiagnostic: null,
});

/** Sanitized account of a failure: ConfigError messages carry no paths or values. */
const describe = (error: unknown): string =>
  error instanceof ConfigError ? error.message : `The local ${IDENTITY_FILE} could not be read.`;

const SOURCE: Record<"--entry" | "--harness" | "environment", ReadIdentitySource> = {
  "--entry": "entry",
  "--harness": "harness",
  environment: "environment",
};

/** Resolve the identity for one read. Never throws and never writes. */
export async function resolveReadIdentity(options: ReadIdentityOptions): Promise<ReadIdentity> {
  if (options.toolAgent) return explicit(options.toolAgent, "tool");
  if (options.startupAgent) return explicit(options.startupAgent, "startup");
  if (!options.project)
    return unresolved(
      "No agent was given and no local project is configured, so no local identity entry was read.",
    );
  const fs = options.fs ?? nodeFileSystem;
  let entry: string;
  let source: ReadIdentitySource;
  try {
    const target = await resolveIdentityTarget(
      options.project,
      options.repository,
      // A shared GitService, a legacy runner, or none: the typed service's isolated default.
      options.git,
    );
    const client =
      options.entry === undefined && options.harness === undefined && options.clientName
        ? detectClientEntry(options.clientName)
        : null;
    // Ori metadata identifies one configured server entry. Codex metadata identifies only
    // the harness, so use the same ambiguity guard as an explicit --harness codex.
    const resolution = await resolveEntry({
      entry: options.entry ?? (client?.harness === "ori" ? client.entry : undefined),
      harness: options.harness ?? client?.harness,
      env: options.env,
      root: target.root,
      fs,
    });
    // The resolver's message names candidates, or that no entry exists and how to create one.
    if (resolution.status === "unresolved") return unresolved(resolution.message);
    entry = resolution.entry;
    source = client ? "client" : SOURCE[resolution.source];
    const record = await readIdentity(target.root, entry, fs);
    if (record.name === null) {
      const why = !record.fileExists
        ? `There is no ${IDENTITY_FILE} at the project root.`
        : !record.entryExists
          ? `${IDENTITY_FILE} has no [agents.${entry}] entry.`
          : `[agents.${entry}] has no valid name.`;
      const problems = record.entryExists ? [] : record.problems;
      return unresolved([why, ...problems].join(" "), entry);
    }
    return {
      agent: record.name,
      source,
      entry,
      triageRole: record.triageRole,
      diagnostic: null,
      store: record.source === "legacy-not-imported" ? "legacy-not-imported" : "pdb",
      storeDiagnostic:
        record.source === "legacy-not-imported"
          ? `Identity read from the legacy ${record.path} because ${IDENTITY_FILE} has no [agents.${entry}] entry; nothing was imported. Import it once with: pdb config set identity.triage_role ${record.triageRole ?? "implementer|designer"} --entry ${entry}`
          : null,
    };
  } catch (error) {
    return unresolved(describe(error));
  }
}
