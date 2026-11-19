/** CLI projection of the shared identity preparer (#677). No argument scanning or allocation here. */
import {
  prepareEffectiveIdentity,
  disabledEffectiveHuman,
  resolveEffectiveHuman,
  type EffectiveIdentity,
  type EffectiveIdentityOptions,
  type EffectiveIdentityRuntime,
} from "./effectiveidentity.js";
import type { AuthContextReader, HumanContextOptions } from "./humancontext.js";

export interface CommandIdentityOptions extends EffectiveIdentityOptions {
  readonly offline?: boolean;
}
export type PrepareCommandIdentity = (
  options: CommandIdentityOptions,
) => Promise<EffectiveIdentity>;

/**
 * Optional next-step suggestions shown once after a verified new identity is created (#681).
 * Only commands this installed version actually routes are offered; nothing is executed and the
 * original operation is never blocked on these. Doctor exists in every shipped build; installer
 * (hook/MCP) snippets are omitted until `pdb install <client>` ships in this version.
 */
export function createdIdentityGuidance(): string[] {
  const lines = ["Optional next steps (nothing runs automatically):"];
  lines.push("  pdb doctor  — verify this checkout's local configuration");
  return lines;
}
/** Production CLI composition, with injectable authentication/cache boundaries for previews. */
export function prepareCommandIdentity(
  options: CommandIdentityOptions,
  runtime: Omit<EffectiveIdentityRuntime, "human"> & {
    auth?: AuthContextReader;
    humanOptions?: HumanContextOptions;
  },
): Promise<EffectiveIdentity> {
  const { auth, humanOptions, ...identityRuntime } = runtime;
  return prepareEffectiveIdentity(options, {
    ...identityRuntime,
    human: () =>
      auth
        ? resolveEffectiveHuman(auth, {
            ...humanOptions,
            offline: options.offline || options.intent === "dry-run" || humanOptions?.offline,
          })
        : Promise.resolve(disabledEffectiveHuman(humanOptions?.host)),
  });
}

type Output = (text: string) => Promise<void>;

/** Expected setup failure, kept out of crash reporting and retaining any persisted outcome. */
export class IdentityPreparationRequired extends Error {
  constructor(readonly identity: EffectiveIdentity) {
    super(identity.diagnostic?.message ?? "An effective agent identity is required.");
  }
}

/** One original CLI invocation; output is forwarded immediately, preserving checkpoint flush order. */
export class CommandIdentity {
  result: EffectiveIdentity | undefined;
  private json = false;

  constructor(
    private readonly prepare: PrepareCommandIdentity,
    private readonly write: Output,
    private readonly stderr: (text: string) => void,
  ) {}

  async select(
    options: CommandIdentityOptions,
    presentation: { json: boolean; allowUnresolved?: boolean },
  ): Promise<EffectiveIdentity> {
    this.json = presentation.json;
    const result = await this.prepare(options);
    this.result = result;
    if (result.agent)
      this.stderr(
        `pdb: Effective agent ${result.agent} (entry ${result.entry ?? "none"}; source ${result.source}; role ${result.role ?? "unknown"}, ${result.roleSource}).\n`,
      );
    for (const notice of result.setup.notices) this.stderr(`pdb: ${notice}\n`);
    // #681: only after a verified first creation, offer the optional next steps as copyable
    // commands. Doctor exists in every build; installer commands are offered only when this
    // installed version actually routes them, so nothing invented or absent is suggested.
    if (result.setup.state === "created") {
      for (const line of createdIdentityGuidance()) this.stderr(`pdb: ${line}\n`);
    }
    if (result.diagnostic)
      this.stderr(`pdb: ${result.diagnostic.message} ${result.diagnostic.recovery}\n`);
    if (!presentation.allowUnresolved && (result.state === "failed" || !result.agent))
      throw new IdentityPreparationRequired(result);
    return result;
  }

  async output(text: string): Promise<void> {
    if (!this.json || !this.result) return this.write(text);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("An attributed CLI result must be one JSON object.");
    await this.write(JSON.stringify({ ...value, effectiveIdentity: this.result }, null, 2) + "\n");
  }

  async refusal(): Promise<number> {
    if (this.json)
      await this.output(
        JSON.stringify({ schemaVersion: 1, kind: "identity-preparation", exitCode: 2 }),
      );
    return 2;
  }
}

/** Shared syntax for local selectors on attributed commands; values are parsed by each command. */
export const identitySelectionOptions = {
  entry: { type: "string" },
  harness: { type: "string" },
  role: { type: "string" },
} as const;
export interface CommandActorOptions {
  readonly repo?: string;
  readonly agent?: string;
  readonly entry?: string;
  readonly harness?: string;
  readonly role?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}
export const identitySelection = (values: CommandActorOptions) => ({
  entry: values.entry,
  harness: values.harness,
  role: values.role,
});

/** Called after command-specific parsing, before live planning or writing. */
export async function commandActor(
  values: CommandActorOptions,
  identity: CommandIdentity | undefined,
  usage: string,
): Promise<string> {
  if (!identity) {
    if (!values.agent) throw new Error(usage);
    return values.agent;
  }
  const result = await identity.select(
    {
      repository: values.repo,
      agent: values.agent,
      ...identitySelection(values),
      intent: values.dryRun ? "dry-run" : "normal",
      authenticationRequired: true,
    },
    { json: !!values.json },
  );
  // select refuses an unresolved/new proposed name; no placeholder can reach a remote plan.
  if (!result.agent) throw new IdentityPreparationRequired(result);
  return result.agent;
}

/** Normal CLI reads reuse the same preparer; explicit offline/preview reads never initialize. */
export async function commandViewer(
  values: CommandActorOptions & { readonly offline?: boolean },
  identity: CommandIdentity | undefined,
  readonly = false,
): Promise<string | undefined> {
  if (!identity) return values.agent;
  // #865 (effective-identity.md "Read-only operations"): every caller is an observational read,
  // so it uses the non-initializing optional-viewer boundary. An explicit or verified existing
  // agent still personalizes; with no safe selection the read continues unattributed, with no
  // allocation, binding, identity/ignore writes or first-use setup.
  void readonly;
  const result = await identity.select(
    {
      repository: values.repo,
      agent: values.agent,
      ...identitySelection(values),
      intent: "readonly",
      offline: values.offline,
      authenticationRequired: false,
    },
    { json: !!values.json, allowUnresolved: true },
  );
  return result.agent ?? undefined;
}
