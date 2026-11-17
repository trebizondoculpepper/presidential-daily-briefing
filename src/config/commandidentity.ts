/** CLI projection of the shared identity preparer (#677). No argument scanning or allocation here. */
import {
  prepareEffectiveIdentity,
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
      resolveEffectiveHuman(auth, {
        ...humanOptions,
        offline: options.offline || options.intent === "dry-run" || humanOptions?.offline,
      }),
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
  const readOnly = readonly || !!values.offline;
  const result = await identity.select(
    {
      repository: values.repo,
      agent: values.agent,
      ...identitySelection(values),
      intent: readOnly ? "readonly" : "normal",
      offline: values.offline,
      authenticationRequired: false,
    },
    { json: !!values.json, allowUnresolved: readOnly },
  );
  return result.agent ?? undefined;
}
