import { installRelease } from "./install.js";
import { CaptureFailure } from "./failure.js";
import { mkdtemp, readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { captureExamples } from "./capture.js";
import { parsePublication, type SiteManifest } from "./manifest.js";
import { resolveRelease } from "./provenance.js";
import { verifyPublication } from "./publication.js";
import { registryBoundary, boundedDownload } from "./registry.js";
import { isolatedEnvironment, createGhTransport } from "./environment.js";
import { runProcess, type RunProcess } from "./process.js";
import { acquireCaptureLock } from "./lock.js";
import { setTimeout as wait } from "node:timers/promises";
import { allowGhRead } from "./gh-policy.js";
import { readBudget } from "./gh-budget.js";
import { buildWebsite } from "./build.js";
import { siteFiles, treeHash, verifySiteArtifact } from "./site-artifact.js";

export async function runCapture(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      help: { type: "boolean" },
      publication: { type: "string" },
      "docs-run": { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run website:capture -- --publication PATH --docs-run ID [--output NEW_DIRECTORY]\nRequires a clean released gitHead checkout and PDB_SITE_GITHUB_TOKEN with repository-scoped read-only access. Builds an artifact; never publishes npm or deploys.",
    );
    return;
  }
  if (!values.publication || !values["docs-run"] || !/^[1-9]\d{0,14}$/.test(values["docs-run"])) {
    throw new CaptureFailure(
      "Required: --publication PATH --docs-run ID [--output NEW_DIRECTORY].",
    );
  }
  const publication = parsePublication(await readFile(values.publication, "utf8"));
  const token = process.env.PDB_SITE_GITHUB_TOKEN;
  if (!token)
    throw new CaptureFailure(
      "PDB_SITE_GITHUB_TOKEN must be an explicitly supplied repository-scoped read-only token.",
    );
  if (process.platform === "win32")
    throw new CaptureFailure(
      "Live capture runs on a POSIX host; fixture checks are cross-platform.",
    );
  const source = process.cwd(),
    output = resolve(values.output ?? "dist/website-release");
  try {
    await stat(output);
    throw new CaptureFailure("Capture output already exists; choose a new directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const unlock = await acquireCaptureLock(
    resolve(tmpdir(), `pdb-website-capture-${process.getuid?.() ?? "user"}.lock`),
  );
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const run: RunProcess = (request) =>
    runProcess({
      ...request,
      signal: request.signal
        ? AbortSignal.any([request.signal, cancellation.signal])
        : cancellation.signal,
    });
  let cleanupRoot: string | undefined;
  try {
    const root = await mkdtemp(resolve(tmpdir(), "pdb-website-capture-"));
    cleanupRoot = root;
    const env = await isolatedEnvironment(root);
    const git = await run({
      file: "git",
      argv: ["rev-parse", "HEAD"],
      cwd: source,
      env,
      timeoutMs: 5000,
    });
    if (git.code !== 0 || git.stdout.trim() !== publication.release.gitHead)
      throw new CaptureFailure(
        "Templates/helpers must be checked out at the exact released gitHead; no main fallback.",
      );
    const status = await run({
      file: "git",
      argv: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: source,
      env,
      timeoutMs: 5000,
    });
    if (status.code !== 0 || status.stdout.trim())
      throw new CaptureFailure("Release source checkout must be clean.");
    const located = await run({
      file: "which",
      argv: ["gh"],
      cwd: root,
      env,
      timeoutMs: 5000,
    });
    if (
      located.code !== 0 ||
      !located.stdout.trim().startsWith("/") ||
      located.stdout.trim().includes("\n")
    )
      throw new CaptureFailure("Installed gh unavailable.");
    const realGh = located.stdout.trim();
    let metadataReads = 0;
    await verifyPublication(publication, async (path) => {
      if (++metadataReads > 5)
        throw new CaptureFailure("Publication verification read limit exceeded.");
      const args = ["api", path];
      allowGhRead(args);
      const result = await run({
        file: realGh,
        argv: args,
        cwd: root,
        env: { ...env, GH_TOKEN: token },
        timeoutMs: 30_000,
        maxBytes: 1_048_576,
      });
      if (result.code !== 0) throw new CaptureFailure("Official publication verification failed.");
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new CaptureFailure("Invalid official publication response.");
      }
    });
    const release = await resolveRelease(publication.release, {
      ...registryBoundary,
      lookup: (version, signal) =>
        registryBoundary.lookup(version, AbortSignal.any([signal, cancellation.signal])),
      wait: async (ms) => {
        await wait(ms, undefined, { signal: cancellation.signal });
      },
    });
    if (
      release.integrity !== publication.release.integrity ||
      release.tarball !== publication.release.tarball
    )
      throw new CaptureFailure("Publication/registry artifact mismatch.");
    const cli = await installRelease(release, {
      root,
      env,
      run,
      download: (url, signal, max) =>
        boundedDownload(url, AbortSignal.any([signal, cancellation.signal]), max),
    });
    const transport = await createGhTransport({
      root,
      source,
      realGh,
      token,
      initialRequests: metadataReads,
      env,
      run,
    });
    let liveDeadline: number | undefined;
    const capture = await captureExamples(publication, {
      now: () => new Date(),
      sensitiveValues: [token],
      controlledPaths: [root],
      privateIdentities: [],
      run: async (args, live) => {
        if (live && liveDeadline === undefined) {
          liveDeadline = Date.now() + 120_000;
          const budget = await readBudget(transport.budgetPath);
          budget.deadline = liveDeadline;
          await writeFile(transport.budgetPath, JSON.stringify(budget), { mode: 0o600 });
        }
        return run({
          file: process.execPath,
          argv: [cli, ...args],
          cwd: root,
          env: {
            ...transport.env,
            GH_TOKEN: live ? token : undefined,
            PDB_SITE_GH_ALLOWED: live ? "1" : "0",
          },
          timeoutMs: live ? Math.max(1, (liveDeadline ?? 0) - Date.now()) : 30_000,
        });
      },
      snapshot: async () => {
        if ((await stat(resolve(root, "snapshot.json"))).size > 32 * 1024 * 1024)
          throw new CaptureFailure("Private snapshot exceeds size limit.");
        return readFile(resolve(root, "snapshot.json"), "utf8");
      },
      assertBudget: async () => {
        const budget = await readBudget(transport.budgetPath);
        if (budget.refused || budget.requests > 50)
          throw new CaptureFailure("Capture request budget/policy was exceeded.");
        return budget.requests;
      },
    });
    const staged = resolve(root, "website");
    cancellation.signal.throwIfAborted();
    await buildWebsite(
      {
        release: {
          version: release.version,
          gitHead: release.gitHead,
          capturedAt: capture.observedAt,
        },
        examples: capture.examples.map((example) => ({
          id: example.id,
          title: example.title,
          command: `pdb ${example.argv.join(" ")}`,
          output: example.text,
          provenance: `${release.version} · ${release.gitHead} · ${example.mode.toUpperCase()} · observed ${example.observedAt ?? "not applicable"} · captured ${example.capturedAt} · exit ${example.exitCode} · ${example.completeness}`,
          notices: [
            ...example.omissions,
            ...(example.mode === "offline"
              ? ["OFFLINE: same captured snapshot; not a fresh live read."]
              : []),
            ...(example.terminalControlsRemoved
              ? ["Terminal controls removed before rendering."]
              : []),
            ...example.redactions,
          ],
        })),
      },
      staged,
    );
    const files = await siteFiles(staged);
    const siteManifest: SiteManifest = {
      schemaVersion: 1,
      publication,
      docsRunId: Number(values["docs-run"]),
      templateRevision: release.gitHead,
      capturedAt: new Date().toISOString(),
      repository: publication.repository.name,
      requests: capture.requests,
      graphqlCost: null,
      policyIdentity: capture.policyIdentity,
      configSha256: null,
      examples: capture.examples,
      screenshots: [],
      files,
      artifactSha256: treeHash(files),
    };
    const json = JSON.stringify(siteManifest, null, 2) + "\n";
    await writeFile(resolve(staged, "site-manifest.json"), json, { mode: 0o600 });
    await verifySiteArtifact(staged, json);
    await mkdir(dirname(output), { recursive: true });
    // Output is a fresh directory. Failed capture never modifies a prior artifact.
    cancellation.signal.throwIfAborted();
    await rename(staged, output);
    console.log(
      `Released website artifact prepared (${release.version}); ${capture.requests} GitHub reads. Not deployed.`,
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    try {
      if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
    } finally {
      await unlock();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runCapture(process.argv.slice(2));
  } catch (error) {
    // Errors from installed programs never cross this boundary with raw stdout/stderr.
    console.error(
      error instanceof CaptureFailure
        ? error.message
        : "Website capture failed; no artifact was produced. Check release input and access.",
    );
    process.exitCode = 1;
  }
}
