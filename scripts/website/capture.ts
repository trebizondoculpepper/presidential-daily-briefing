import { CaptureFailure } from "./failure.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type CapturedExample, type PublicationManifest } from "./manifest.js";
import { publicRepository } from "./provenance.js";
import { sanitizeOutput } from "./sanitize.js";
import type { ProcessResult } from "./process.js";

export interface CaptureBoundary {
  now(): Date;
  run(this: void, argv: readonly string[], live: boolean): Promise<ProcessResult>;
  snapshot(): Promise<string>;
  assertBudget(): Promise<number>;
  sensitiveValues: string[];
  controlledPaths: string[];
  privateIdentities: string[];
}
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal(publicRepository),
  fetchedAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  issues: z.array(z.unknown()),
  pullRequests: z.array(z.unknown()),
  dependencies: z.array(z.unknown()),
  changed: z.array(z.unknown()),
  warnings: z.array(z.string().max(4096)).max(100),
});
const common = ["--repo", publicRepository, "--no-update-check"];
const focus = ["--agent", "website_example", "--limit", "3"];
/** One code-owned plan. No issue text, CLI caller or manifest can add an executable command. */
export async function captureExamples(
  publication: PublicationManifest,
  boundary: CaptureBoundary,
): Promise<{
  examples: CapturedExample[];
  policyIdentity: string | null;
  requests: number;
  observedAt: string;
}> {
  const examples: CapturedExample[] = [];
  let total = 0;
  const record = async (
    id: string,
    title: string,
    argv: readonly string[],
    mode: "local" | "live" | "offline",
    observedAt: string | null,
    omissions: string[] = [],
  ): Promise<ProcessResult> => {
    const result = await boundary.run(argv, mode === "live");
    await boundary.assertBudget();
    if (result.code !== 0 && result.code !== 2)
      throw new CaptureFailure(`Capture command ${id} failed; output discarded.`);
    // Stderr is scanned too. Its notices must not disappear from a partial capture.
    const sanitized = sanitizeOutput(
      result.stdout + (result.stderr ? `\n[stderr notices]\n${result.stderr}` : ""),
      boundary,
    );
    const safeOmissions = omissions.map((x) => sanitizeOutput(x, boundary).text);
    total += Buffer.byteLength(sanitized.text);
    if (total > 10 * 1024 * 1024) throw new CaptureFailure("Sanitized capture exceeds 10 MiB.");
    const completeness =
      mode === "local"
        ? "not-applicable"
        : result.code === 2 || omissions.length
          ? "partial"
          : "complete";
    examples.push({
      id,
      title,
      argv: [...argv],
      mode,
      capturedAt: boundary.now().toISOString(),
      observedAt,
      exitCode: result.code,
      completeness,
      omissions: safeOmissions,
      truncated: false,
      ...sanitized,
    });
    return result;
  };
  const version = await record(
    "version",
    "Installed artifact",
    ["version", "--no-update-check"],
    "local",
    null,
  );
  if (
    version.code !== 0 ||
    version.stdout.split(/\r?\n/)[0]?.trim() !== `pdb ${publication.release.version}`
  )
    throw new CaptureFailure("Installed CLI version mismatch.");
  const help = await record("help", "Released command help", ["--help"], "local", null);
  if (
    help.code !== 0 ||
    !["--repo", "--cache", "--offline", "--role", "rules"].every((flag) =>
      help.stdout.includes(flag),
    )
  ) {
    throw new CaptureFailure("Release lacks required capture commands; no source fallback.");
  }
  const rules = await record("rules", "Released workflow policy", ["rules"], "local", null);
  if (rules.code !== 0 || !rules.stdout.trim())
    throw new CaptureFailure("Release rules unavailable.");
  if (/\bonboard\b/.test(help.stdout)) {
    const onboard = await record(
      "onboarding-help",
      "Released onboarding help",
      ["onboard", "--help"],
      "local",
      null,
    );
    if (onboard.code !== 0) throw new CaptureFailure("Advertised onboarding help unsupported.");
  }
  const liveStartedAt = boundary.now().getTime();
  const live = await record(
    "implementer-live",
    "Implementer · live capture",
    [...common, ...focus, "--role", "implementer", "--cache", "snapshot.json"],
    "live",
    null,
  );
  const raw = await boundary.snapshot();
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024)
    throw new CaptureFailure("Private snapshot exceeds 32 MiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CaptureFailure("Capture did not produce a valid reusable snapshot.");
  }
  const snapshot = snapshotSchema.safeParse(parsed);
  if (!snapshot.success)
    throw new CaptureFailure("Capture snapshot schema or repository mismatch.");
  const observedAt = snapshot.data.fetchedAt;
  if (
    Date.parse(observedAt) < liveStartedAt - 1000 ||
    Date.parse(snapshot.data.startedAt) < liveStartedAt - 1000 ||
    Date.parse(observedAt) > boundary.now().getTime() + 1000
  )
    throw new CaptureFailure("Snapshot observation does not belong to this capture.");
  const liveExample = examples.find((x) => x.id === "implementer-live")!;
  liveExample.observedAt = observedAt;
  liveExample.omissions = snapshot.data.warnings.map((x) => sanitizeOutput(x, boundary).text);
  liveExample.completeness =
    live.code === 2 || liveExample.omissions.length ? "partial" : "complete";
  for (const role of ["designer", "human"] as const) {
    await record(
      `${role}-offline`,
      `${role === "human" ? "Human director" : "Designer"} · OFFLINE snapshot projection`,
      [...common, ...focus, "--role", role, "--offline", "--cache", "snapshot.json"],
      "offline",
      observedAt,
      snapshot.data.warnings,
    );
  }
  // Hashes describe exactly the sanitized bytes presented; the private snapshot is never exported.
  for (const example of examples)
    if (createHash("sha256").update(example.text).digest("hex") !== example.sha256) {
      throw new CaptureFailure("Capture hash mismatch.");
    }
  return {
    examples,
    policyIdentity: /rulesHash ([a-f0-9]{64})/.exec(rules.stdout)?.[1] ?? null,
    observedAt,
    requests: await boundary.assertBudget(),
  };
}
