import { CaptureFailure } from "./failure.js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { siteManifestSchema, type SiteManifest } from "./manifest.js";
import { conversations } from "../../website/conversations.js";

const illustrationHashes = new Map<string, string>(
  conversations.map((item) => [`assets/conversations/${item.file}`, item.sha256]),
);

export const hash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const treeHash = (files: Record<string, string>): string =>
  hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
export async function siteFiles(root: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (path === "site-manifest.json") {
      if (!entry.isFile()) throw new CaptureFailure("Site manifest must be a regular file.");
      continue;
    }
    if (entry.isDirectory()) Object.assign(files, await siteFiles(root, `${path}/`));
    else if (
      entry.isFile() &&
      (/^(?:[a-z-]+\/)*[a-z-]+\.(?:html|css|js)$/.test(path) || illustrationHashes.has(path))
    ) {
      const digest = hash(await readFile(resolve(root, path)));
      if (illustrationHashes.has(path) && illustrationHashes.get(path) !== digest)
        throw new CaptureFailure("Conversation illustration differs from its reviewed source.");
      files[path] = digest;
    } else throw new CaptureFailure("Unexpected or symlinked website artifact entry.");
  }
  if (!prefix && [...illustrationHashes.keys()].some((path) => !files[path]))
    throw new CaptureFailure("Conversation illustration missing.");
  return files;
}
export async function verifySiteArtifact(root: string, raw: string): Promise<SiteManifest> {
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024)
    throw new CaptureFailure("Site manifest exceeds size limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CaptureFailure("Site manifest is not JSON.");
  }
  const result = siteManifestSchema.safeParse(parsed);
  if (!result.success) throw new CaptureFailure("Invalid site manifest schema.");
  const manifest = result.data;
  if (
    manifest.templateRevision !== manifest.publication.release.gitHead ||
    manifest.publication.publisher.sourceSha !== manifest.templateRevision ||
    manifest.publication.officialRelease.tag !== `v${manifest.publication.release.version}` ||
    manifest.examples.some((x) => hash(x.text) !== x.sha256)
  )
    throw new CaptureFailure("Site manifest provenance/hash mismatch.");
  const files = await siteFiles(root);
  for (const path of [
    "index.html",
    "how-it-works/index.html",
    "getting-started/index.html",
    "use-cases/index.html",
  ]) {
    const html = await readFile(resolve(root, path), "utf8");
    if (
      !html.includes(
        `<meta name="pdb-version" content="${manifest.publication.release.version}">`,
      ) ||
      !html.includes(`<meta name="pdb-source" content="${manifest.templateRevision}">`)
    ) {
      throw new CaptureFailure("Rendered website release identity mismatch.");
    }
  }
  if (!files["assets/site.css"] || !files["assets/copy.js"])
    throw new CaptureFailure("Website assets missing.");
  if (
    Object.keys(files).length !== Object.keys(manifest.files).length ||
    Object.entries(files).some(([path, digest]) => manifest.files[path] !== digest) ||
    treeHash(files) !== manifest.artifactSha256
  )
    throw new CaptureFailure("Website artifact file mismatch.");
  return manifest;
}
