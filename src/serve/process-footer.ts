/** Startup-bound process identity and its shared HTML footer; no live project/network lookup. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BlockList, isIP } from "node:net";
import { installedVersion } from "../updates/updates.js";
import { htmlEscape, pageHref, servedPages, type ShellContext } from "./shell.js";
import type { BuildIdentity, ProcessIdentity, ServerFacts } from "./types.js";

export const unknownBuildIdentity = (): BuildIdentity => ({
  revision: null,
  dirty: null,
  publicIp: null,
  source: "unknown",
});
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** A release manifest's gitHead is not provenance for a mutable source checkout. */
export function packageBuildIdentity(manifest: unknown, installed: boolean): BuildIdentity {
  if (!installed || !manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return unknownBuildIdentity();
  const revision = (manifest as Record<string, unknown>).gitHead;
  return typeof revision === "string" && revisionPattern.test(revision)
    ? { revision, dirty: null, publicIp: null, source: "package-githead" }
    : unknownBuildIdentity();
}

/** Reads only the executing package's verified manifest, once during real server startup. */
export async function readPackageBuildIdentity(): Promise<BuildIdentity> {
  try {
    const info = await installedVersion(import.meta.url);
    if (!info.installed || !info.root) return unknownBuildIdentity();
    return packageBuildIdentity(
      JSON.parse(await readFile(join(info.root, "package.json"), "utf8")),
      true,
    );
  } catch {
    return unknownBuildIdentity();
  }
}

// Conservatively show only globally scoped literals from an already trusted runtime source.
// This never discovers an address or treats the listener/loopback address as a public IP.
const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  nonPublicV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [
  ["2001:db8::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["3fff::", 20],
] as const)
  nonPublicV6.addSubnet(address, prefix, "ipv6");
export function publicIpLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const kind = isIP(value);
  if (kind === 4) return nonPublicV4.check(value, "ipv4") ? null : value;
  if (kind === 6)
    return globalV6.check(value, "ipv6") && !nonPublicV6.check(value, "ipv6") ? value : null;
  return null;
}

/** Copy primitives once: later package, clock, runtime-provider or project changes cannot rewrite it. */
export function captureProcessIdentity(
  facts: Pick<ServerFacts, "version" | "startedAt">,
  build: Partial<BuildIdentity> = {},
): Readonly<ProcessIdentity> {
  const revision =
    typeof build.revision === "string" && revisionPattern.test(build.revision)
      ? build.revision
      : null;
  const source =
    build.source === "build-metadata" || (build.source === "package-githead" && revision)
      ? build.source
      : "unknown";
  return Object.freeze({
    version: facts.version,
    startedAt: Number.isFinite(facts.startedAt.getTime()) ? facts.startedAt.toISOString() : null,
    revision,
    dirty: source !== "unknown" && typeof build.dirty === "boolean" ? build.dirty : null,
    publicIp: publicIpLiteral(build.publicIp),
    source,
  });
}

export function renderProcessIdentity(
  identity: Readonly<ProcessIdentity>,
  context?: ShellContext,
): string {
  const revision = identity.revision
    ? `<code title="${htmlEscape(identity.revision)}">${htmlEscape(identity.revision.slice(0, 12))}</code>`
    : "unknown";
  const started = identity.startedAt
    ? `<time datetime="${htmlEscape(identity.startedAt)}">${htmlEscape(identity.startedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"))}</time>`
    : "unknown";
  const doctor = context && servedPages.find((page) => page.id === "diagnostics" && page.shipped);
  const link = doctor
    ? ` <a href="${htmlEscape(
        pageHref(
          doctor,
          context!.selection,
          servedPages.find((p) => p.id === context!.page),
        ),
      )}">Doctor</a>`
    : "";
  return `<section class="process-identity" aria-label="Running PDB process"><span>PDB ${htmlEscape(identity.version ?? "unknown")}</span><span>Source: ${revision}</span><span>Dirty build: ${identity.dirty === null ? "unknown" : identity.dirty ? "yes" : "no"}</span><span>Started: ${started}</span><span>Public IP: ${htmlEscape(identity.publicIp ?? "unavailable")}</span>${link}</section>`;
}

/** Page templates are trusted markup; preserve their safety text inside the same footer. */
export function withProcessIdentity(
  html: string,
  identity: Readonly<ProcessIdentity>,
  context?: ShellContext,
): string {
  const content = renderProcessIdentity(identity, context);
  const footerEnd = html.lastIndexOf("</footer>");
  if (footerEnd >= 0) return html.slice(0, footerEnd) + content + html.slice(footerEnd);
  return html.replace("</body>", `<footer>${content}</footer></body>`);
}
