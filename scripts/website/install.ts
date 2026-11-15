import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CaptureFailure } from "./failure.js";
import { verifyTarball, packageName, type ReleaseIdentity } from "./provenance.js";
import type { RunProcess } from "./process.js";

export async function installRelease(
  release: ReleaseIdentity,
  options: {
    root: string;
    env: NodeJS.ProcessEnv;
    run: RunProcess;
    download(url: string, signal: AbortSignal, maximum: number): Promise<Buffer>;
  },
): Promise<string> {
  const tarball = await options.download(
    release.tarball,
    AbortSignal.timeout(60_000),
    20 * 1024 * 1024,
  );
  verifyTarball(tarball, release);
  const archive = resolve(options.root, "package.tgz"),
    prefix = resolve(options.root, "installed");
  await writeFile(archive, tarball, { mode: 0o600 });
  const installed = await options.run({
    file: "npm",
    argv: [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      archive,
    ],
    cwd: options.root,
    env: options.env,
    timeoutMs: 120_000,
  });
  if (installed.code !== 0)
    throw new CaptureFailure("Isolated released-artifact installation failed.");
  const packageRoot = resolve(prefix, "node_modules", packageName);
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    manifest.name !== packageName ||
    manifest.version !== release.version ||
    manifest.gitHead !== release.gitHead
  ) {
    throw new CaptureFailure("Installed package identity mismatch.");
  }
  return resolve(packageRoot, "dist/cli.mjs");
}
