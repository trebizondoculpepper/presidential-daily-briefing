import { CaptureFailure } from "./failure.js";
import { createHash } from "node:crypto";

export const packageName = "@trebizondoculpepper/presidential-daily-briefing";
export const publicRepository = "trebizondoculpepper/presidential-daily-briefing";
export interface ReleaseIdentity {
  package: typeof packageName;
  version: string;
  gitHead: string;
  integrity: string;
  tarball: string;
}
export interface RegistryMetadata {
  name: string;
  version: string;
  gitHead: string;
  dist: { integrity: string; tarball: string };
}

export function stableVersion(value: string): boolean {
  return value.length <= 80 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
export function compareVersions(left: string, right: string): number {
  if (!stableVersion(left) || !stableVersion(right))
    throw new CaptureFailure("Expected stable versions.");
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export function pinRelease(
  expected: { version: string; gitHead: string },
  latest: string,
  metadata: RegistryMetadata,
): ReleaseIdentity {
  if (!stableVersion(expected.version) || !/^[a-f0-9]{40}$/.test(expected.gitHead)) {
    throw new CaptureFailure("Invalid expected stable release identity.");
  }
  if (
    latest !== expected.version ||
    metadata.version !== expected.version ||
    metadata.gitHead !== expected.gitHead ||
    metadata.name !== packageName
  ) {
    throw new CaptureFailure("Release, stable tag and exact registry identity do not match.");
  }
  // npm's tarball URL is data, never a command or an arbitrary download destination.
  const url = new URL(metadata.dist.tarball);
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`/${packageName}/-/`)
  ) {
    throw new CaptureFailure("Unexpected npm tarball location.");
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity)) {
    throw new CaptureFailure("Expected canonical SHA-512 npm integrity.");
  }
  return Object.freeze({
    package: packageName,
    version: expected.version,
    gitHead: expected.gitHead,
    integrity: metadata.dist.integrity,
    tarball: url.href,
  });
}

export function verifyTarball(bytes: Uint8Array, release: ReleaseIdentity): void {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new CaptureFailure("Tarball exceeds 20 MiB.");
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== release.integrity) throw new CaptureFailure("Tarball integrity mismatch.");
}

export interface RegistryBoundary {
  now(): number;
  wait(milliseconds: number): Promise<void>;
  lookup(
    version: string,
    signal: AbortSignal,
  ): Promise<{ latest: string; metadata: RegistryMetadata | null }>;
}
/** A successful identity is returned once; later stages may reject, never retarget it. */
export async function resolveRelease(
  expected: { version: string; gitHead: string },
  boundary: RegistryBoundary,
): Promise<ReleaseIdentity> {
  if (!stableVersion(expected.version) || !/^[a-f0-9]{40}$/.test(expected.gitHead))
    throw new CaptureFailure("Invalid expected stable release identity.");
  const deadline = boundary.now() + 120_000;
  for (let attempt = 0; attempt < 6 && boundary.now() < deadline; attempt++) {
    const observed = await boundary.lookup(
      expected.version,
      AbortSignal.timeout(Math.max(1, deadline - boundary.now())),
    );
    if (boundary.now() >= deadline)
      throw new CaptureFailure("Registry propagation deadline exceeded.");
    if (stableVersion(observed.latest) && compareVersions(observed.latest, expected.version) > 0) {
      throw new CaptureFailure("Release superseded before capture.");
    }
    if (observed.latest === expected.version && observed.metadata)
      return pinRelease(expected, observed.latest, observed.metadata);
    if (!stableVersion(observed.latest)) throw new CaptureFailure("Invalid stable tag metadata.");
    if (attempt < 5) await boundary.wait(Math.min(20_000, deadline - boundary.now()));
  }
  throw new CaptureFailure(
    "Registry propagation did not converge within six probes / 120 seconds.",
  );
}
