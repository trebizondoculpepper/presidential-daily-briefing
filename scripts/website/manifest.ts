import { CaptureFailure } from "./failure.js";
import { z } from "zod";
import { packageName, publicRepository } from "./provenance.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stable = z
  .string()
  .max(80)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.iso.datetime();
export const releaseSchema = z
  .object({
    package: z.literal(packageName),
    version: stable,
    gitHead: sha,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    tarball: z
      .string()
      .url()
      .max(1024)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.origin === "https://registry.npmjs.org" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname.startsWith(`/${packageName}/-/`)
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
export const publicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.object({ id: positive, name: z.literal(publicRepository) }).strict(),
    publisher: z
      .object({
        workflowId: positive,
        workflowPath: z.literal(".github/workflows/publish.yml"),
        runId: positive,
        attempt: positive,
        event: z.literal("workflow_dispatch"),
        ref: z.literal("refs/heads/release"),
        sourceSha: sha,
      })
      .strict(),
    channel: z.literal("latest"),
    release: releaseSchema,
    officialRelease: z
      .object({ id: positive, tag: z.string().max(100), publishedAt: date })
      .strict(),
    completed: z.literal(true),
  })
  .strict();
export type PublicationManifest = z.infer<typeof publicationSchema>;

export function parsePublication(raw: string): PublicationManifest {
  if (Buffer.byteLength(raw) > 16_384) throw new CaptureFailure("Publication manifest too large.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CaptureFailure("Publication manifest is not JSON.");
  }
  const parsed = publicationSchema.safeParse(value);
  if (!parsed.success) throw new CaptureFailure("Invalid publication manifest schema.");
  const result = parsed.data;
  if (
    result.release.gitHead !== result.publisher.sourceSha ||
    result.officialRelease.tag !== `v${result.release.version}`
  )
    throw new CaptureFailure("Conflicting publication identities.");
  return result;
}

export const exampleSchema = z
  .object({
    id: z.string().regex(/^[a-z-]+$/),
    argv: z.array(z.string().max(1024)).max(30),
    title: z.string().max(100),
    mode: z.enum(["local", "live", "offline"]),
    capturedAt: date,
    observedAt: date.nullable(),
    exitCode: z.union([z.literal(0), z.literal(2)]),
    completeness: z.enum(["complete", "partial", "not-applicable"]),
    omissions: z.array(z.string().max(4096)).max(100),
    truncated: z.literal(false),
    text: z.string().max(2 * 1024 * 1024),
    sha256: digest,
    terminalControlsRemoved: z.boolean(),
    redactions: z.array(z.string().max(200)).max(20),
  })
  .strict();
export type CapturedExample = z.infer<typeof exampleSchema>;
export const siteManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    publication: publicationSchema,
    docsRunId: positive,
    templateRevision: sha,
    capturedAt: date,
    repository: z.literal(publicRepository),
    requests: z.number().int().min(0).max(50),
    graphqlCost: z.null(),
    policyIdentity: z.string().max(256).nullable(),
    configSha256: digest.nullable(),
    examples: z.array(exampleSchema).min(1).max(10),
    screenshots: z.array(z.never()).max(0),
    files: z.record(z.string().max(200), digest),
    artifactSha256: digest,
  })
  .strict();
export type SiteManifest = z.infer<typeof siteManifestSchema>;
