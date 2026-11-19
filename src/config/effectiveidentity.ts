/** Shared identity preparation (#677, doc/design/effective-identity.md). */
import {
  ConfigError,
  nodeFileSystem,
  resolveRepositoryTarget,
  type ConfigFileSystem,
  type GitRunner,
} from "./config.js";
import { activeBinding, type ActiveBinding } from "./activebinding.js";
import { validateHarness, type Environment } from "./harness.js";
import {
  IDENTITY_FILE,
  TRIAGE_ROLES,
  isAgentName,
  readIdentityBindingSelection,
  readBoundIdentity,
  readIdentity,
  readIdentityBindings,
  setIdentity,
  validateEntryKey,
  type IdentityRecord,
  type IdentitySource,
  type IdentityWriteResult,
  type TriageRole,
  gitServiceOf,
} from "./identity.js";
import type { GitService } from "../git/service.js";
import {
  resolveHumanContext,
  type AuthContextReader,
  type HumanContext,
  type HumanContextOptions,
} from "./humancontext.js";

export interface EffectiveHuman {
  readonly context: HumanContext;
  /** A typed authentication refusal, not an inference from an outage or error-message text. */
  readonly authenticationFailed: boolean;
}

/** An explicit front-end opt-out does not consult a prior account or its cache. */
export const disabledEffectiveHuman = (host = "github.com"): EffectiveHuman => ({
  context: {
    state: "unresolved",
    host,
    login: null,
    source: "none",
    reason: "Employing-human lookup is disabled for this invocation.",
  },
  authenticationFailed: false,
});

/** Reuse the one human resolver while preserving the factual credential-failure category. */
export async function resolveEffectiveHuman(
  read: AuthContextReader | undefined,
  options: HumanContextOptions = {},
): Promise<EffectiveHuman> {
  let authenticationFailed = false;
  const reader: AuthContextReader | undefined =
    read &&
    (async (signal) => {
      try {
        return await read(signal);
      } catch (error) {
        authenticationFailed = (error as { authentication?: unknown })?.authentication === true;
        throw error;
      }
    });
  return { context: await resolveHumanContext(reader, options), authenticationFailed };
}

export interface EffectiveIdentity {
  readonly schemaVersion: 1;
  /** Preparation outcome, not workflow eligibility, permission or live presence. */
  readonly state: "resolved" | "unresolved" | "proposed" | "failed";
  readonly agent: string | null;
  readonly entry: string | null;
  readonly source: "explicit-agent" | "entry" | "binding" | "unresolved";
  readonly store: IdentitySource | null;
  readonly bindingProvider: string | null;
  readonly triageRole: TriageRole | null;
  readonly role: TriageRole | null;
  readonly roleSource: "explicit" | "stored" | "unknown";
  readonly human: HumanContext;
  readonly diagnostic: { code: string; message: string; recovery: string } | null;
  readonly setup: {
    readonly state:
      | "not-needed"
      | "reused"
      | "created"
      | "imported"
      | "bound"
      | "proposed"
      | "failed"
      | "persisted-with-error";
    readonly changed: boolean | null;
    readonly persisted: boolean | null;
    readonly notices: readonly string[];
    readonly persistedAgent?: { readonly name: string; readonly entry: string };
  };
}

export interface EffectiveIdentityOptions {
  readonly project?: string;
  /** Local services never borrow their launch directory when no startup project was selected. */
  readonly requireProject?: boolean;
  readonly repository?: string;
  /** Trusted local per-call override; remote display arguments must not populate this. */
  readonly agent?: string;
  readonly entry?: string;
  readonly harness?: string;
  readonly role?: string;
  readonly intent: "normal" | "readonly" | "dry-run";
  /** Technical authentication requirement of the original operation, not ownership admission. */
  readonly authenticationRequired?: boolean;
}

export interface EffectiveIdentityRuntime {
  readonly cwd?: string;
  readonly env: Environment;
  readonly fs?: ConfigFileSystem;
  /** The shared typed Git service; a legacy runner is accepted as its transport. */
  readonly git?: GitService | GitRunner;
  readonly random?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly human: () => Promise<EffectiveHuman>;
}

const unknownHuman: HumanContext = {
  state: "unresolved",
  host: "github.com",
  login: null,
  source: "none",
  reason: "Human context was not read because identity selection did not complete.",
};
const selectionError = (
  message: string,
  recovery = "Select the intended logical entry with --entry KEY; supply --role implementer|designer when creating a new identity.",
  /** #865: `identity-absent` marks genuine absence only; broken or invalid bindings keep `identity-unresolved`. */
  code: "identity-unresolved" | "identity-absent" = "identity-unresolved",
) => new ConfigError(code, message, recovery);
const problem = (error: unknown): NonNullable<EffectiveIdentity["diagnostic"]> =>
  error instanceof ConfigError
    ? error.code === "not-a-repository" || error.code === "repository-mismatch"
      ? {
          code: error.code,
          message:
            error.code === "not-a-repository"
              ? "The selected local project is not a Git checkout."
              : "The selected checkout does not match the requested GitHub repository.",
          recovery:
            "Run from the intended local checkout and pass --repo owner/name when it has several GitHub remotes; no identity was selected for another project.",
        }
      : { code: error.code, message: error.message, recovery: error.recovery }
    : {
        code: "filesystem",
        message: "Local identity preparation failed.",
        recovery: `Check access to ${IDENTITY_FILE} at the verified project root and retry; no new identity was verified.`,
      };

/** Normal first use may initialize; explicit reads and dry-runs never write identity. */
export async function prepareEffectiveIdentity(
  options: EffectiveIdentityOptions,
  runtime: EffectiveIdentityRuntime,
): Promise<EffectiveIdentity> {
  let human = unknownHuman;
  let entry: string | null = null;
  let provider: ActiveBinding | null = null;
  let source: EffectiveIdentity["source"] = "unresolved";
  let role: TriageRole | undefined;
  let target: Awaited<ReturnType<typeof resolveRepositoryTarget>> | undefined;
  let attempted = false;
  const fs = runtime.fs ?? nodeFileSystem;
  // One typed Git service for this preparation (#907): shared if injected, else built once.
  const git = gitServiceOf(runtime.git);
  const base = (): EffectiveIdentity => ({
    schemaVersion: 1,
    state: "unresolved",
    agent: null,
    entry,
    source,
    store: null,
    bindingProvider: provider?.provider ?? null,
    triageRole: null,
    role: role ?? null,
    roleSource: role ? "explicit" : "unknown",
    human,
    diagnostic: null,
    setup: { state: "not-needed", changed: false, persisted: null, notices: [] },
  });
  const resolved = (
    record: IdentityRecord,
    setup: EffectiveIdentity["setup"],
  ): EffectiveIdentity => ({
    ...base(),
    state: "resolved",
    agent: record.name,
    store: record.source,
    triageRole: record.triageRole,
    role: role ?? record.triageRole,
    roleSource: role ? "explicit" : record.triageRole ? "stored" : "unknown",
    setup,
  });
  try {
    if (options.entry !== undefined && options.harness !== undefined)
      throw new ConfigError(
        "invalid-value",
        "Use --entry or --harness, not both.",
        "Select one logical entry or harness.",
      );
    if (options.entry !== undefined) validateEntryKey(options.entry);
    if (options.harness !== undefined) validateHarness(options.harness);
    if (options.role !== undefined) {
      if (!(TRIAGE_ROLES as readonly string[]).includes(options.role))
        throw new ConfigError(
          "invalid-value",
          "An identity bootstrap role must be implementer or designer.",
          "Select a supported triage role explicitly; a human display role is not an agent role.",
        );
      role = options.role as TriageRole;
    }
    if (options.agent !== undefined && !isAgentName(options.agent))
      throw new ConfigError(
        "invalid-value",
        "Invalid explicit agent name.",
        "Use a valid agent name of at most 100 characters.",
      );
    const readHuman = await runtime.human();
    human = readHuman.context;
    if (readHuman.authenticationFailed && options.authenticationRequired)
      throw new ConfigError(
        "identity-unresolved",
        "The authenticated GitHub human could not be resolved because authentication was refused.",
        "Run gh auth status and sign in through the supported gh authentication flow, then retry.",
      );
    if (options.agent !== undefined)
      return { ...base(), state: "resolved", agent: options.agent, source: "explicit-agent" };

    if (options.requireProject && !options.project)
      throw selectionError(
        "No local project is selected; the server launch directory was not consulted.",
        "Select a local startup project with --project PATH, or use an explicit local --agent override.",
      );

    target = await resolveRepositoryTarget(
      options.project ?? runtime.cwd ?? process.cwd(),
      options.repository,
      git,
    );
    provider = activeBinding({
      root: target.root,
      repository: target.repository,
      env: runtime.env,
      platform: runtime.platform,
    });
    if (provider && options.harness !== undefined && provider.harness !== options.harness)
      provider = null;
    let bindings = await readIdentityBindings(target.root, fs);
    let newSession = false;
    let record: IdentityRecord;
    if (options.entry !== undefined) {
      entry = options.entry;
      source = "entry";
      record = await readIdentity(target.root, entry, fs);
    } else if (provider) {
      source = "binding";
      const selection = await readIdentityBindingSelection(target.root, provider.key, fs);
      bindings = selection.bindings;
      const bound = selection.bound;
      if (bound) {
        entry = bound.entry;
        record = bound.record;
      } else {
        const boundEntries = new Set(bindings.values());
        const keys = selection.entries;
        if (
          keys.some(
            (key) =>
              (key === provider!.harness || key.startsWith(`${provider!.harness}.`)) &&
              !boundEntries.has(key),
          )
        )
          throw selectionError(
            "An unbound existing entry makes this session's identity ambiguous.",
          );
        entry = provider.entry;
        if (keys.includes(entry))
          throw selectionError(
            "The session entry already exists without this active binding; it was not borrowed.",
          );
        newSession = true;
        record = await readIdentity(target.root, entry, fs);
      }
    } else
      throw selectionError(
        "No verified per-agent binding is available for this invocation.",
        // #865: a read continues unattributed and never suggests creating an identity; an
        // attributed operation still gets the selection and setup recovery.
        options.intent === "readonly"
          ? "The read continues without an agent attribution; --agent or --entry KEY personalizes it."
          : undefined,
        "identity-absent",
      );

    if (record.problems.length) throw selectionError(record.problems.join(" "));
    if ((record.entryExists || record.name !== null) && (!record.name || !isAgentName(record.name)))
      throw selectionError(
        "The selected identity entry has no valid agent name; no replacement was allocated.",
        `Repair it with pdb config set identity.name NAME --entry ${entry}, then retry.`,
      );
    const bindingNeeded = provider !== null && bindings.get(provider.key) !== entry;
    const needsWrite = !record.name || record.source === "legacy-not-imported" || bindingNeeded;
    if (options.intent === "readonly") {
      if (!record.name)
        // #865: a read never suggests creating an identity; it continues unattributed.
        throw selectionError(
          "The selected identity has not been initialized; this read did not initialize it.",
          "The read continues without an agent attribution.",
          "identity-absent",
        );
      return resolved(record, {
        state: "reused",
        changed: false,
        persisted: record.source === "pdb",
        notices: [],
      });
    }
    if (options.intent === "dry-run") {
      if (!needsWrite)
        return resolved(record, { state: "reused", changed: false, persisted: true, notices: [] });
      return {
        ...base(),
        state: "proposed",
        agent: record.name,
        store: record.source,
        triageRole: record.triageRole,
        role: role ?? record.triageRole,
        roleSource: role ? "explicit" : record.triageRole ? "stored" : "unknown",
        diagnostic:
          !record.name && !role
            ? problem(
                selectionError(
                  "A new identity would need an explicit triage role; none was inferred.",
                ),
              )
            : null,
        setup: {
          state: "proposed",
          changed: false,
          persisted: false,
          notices: [
            `Would prepare identity for entry ${entry}; no name was allocated or persisted.`,
          ],
        },
      };
    }
    if (!needsWrite)
      return resolved(record, { state: "reused", changed: false, persisted: true, notices: [] });
    if (!record.name && !role)
      throw selectionError("A new identity needs an explicit triage role; none was inferred.");
    attempted = true;
    const write: IdentityWriteResult = await setIdentity(
      target,
      entry,
      record.name ? "identity.name" : "identity.triage_role",
      record.name ?? role!,
      {
        fs,
        git,
        random: runtime.random,
        requireName: true,
        reuseExistingIdentity: true,
        ...(provider
          ? {
              binding: {
                key: provider.key,
                expectedEntry: bindings.get(provider.key) ?? null,
                allowRebind: options.entry !== undefined,
                ...(newSession ? { newSessionHarness: provider.harness } : {}),
              },
            }
          : {}),
      },
    );
    const verified = provider
      ? await readBoundIdentity(target.root, provider.key, fs)
      : { entry, record: await readIdentity(target.root, entry, fs) };
    if (
      !verified ||
      verified.entry !== entry ||
      verified.record.source !== "pdb" ||
      verified.record.name !== write.record.name
    )
      throw selectionError(
        "Identity persistence could not be verified; the original operation was not continued.",
      );
    const state = write.generatedName
      ? "created"
      : write.importedFrom
        ? "imported"
        : write.changed
          ? "bound"
          : "reused";
    const notices =
      state === "created"
        ? [
            `While preparing your requested command, PDB created agent identity ${verified.record.name} and saved it for this session/entry; continuing as ${verified.record.name}.`,
          ]
        : state === "imported"
          ? [
              `PDB imported the existing identity ${verified.record.name} once into ${IDENTITY_FILE}; continuing with that name.`,
            ]
          : state === "bound"
            ? [
                `PDB saved the selection of existing identity ${verified.record.name} for this local context.`,
              ]
            : [];
    if (write.lockCleanup) notices.push(write.lockCleanup);
    return resolved(verified.record, { state, changed: write.changed, persisted: true, notices });
  } catch (error) {
    // A failed post-rename chmod/readback may leave a real persisted identity. Report it;
    // never retry initialization blindly or claim the original operation continued.
    let persisted: { name: string; entry: string } | undefined;
    if (attempted && target && entry) {
      try {
        const current = await readIdentity(target.root, entry, fs);
        if (current.source === "pdb" && current.name && isAgentName(current.name))
          persisted = { name: current.name, entry };
      } catch {
        /* Unknown is not proof that persistence failed or that it is safe to allocate again. */
      }
    }
    return {
      ...base(),
      source: "unresolved",
      state: attempted ? "failed" : "unresolved",
      diagnostic: problem(error),
      setup: {
        state: persisted ? "persisted-with-error" : attempted ? "failed" : "not-needed",
        changed: attempted ? null : false,
        persisted: persisted ? true : attempted ? null : false,
        notices: persisted
          ? [
              `Identity ${persisted.name} is present in ${IDENTITY_FILE}, but setup reported an error; the original operation was not continued.`,
            ]
          : [],
        ...(persisted ? { persistedAgent: persisted } : {}),
      },
    };
  }
}
