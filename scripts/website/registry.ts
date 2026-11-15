import { CaptureFailure } from "./failure.js";
import { z } from "zod";
import { packageName, type RegistryBoundary } from "./provenance.js";
import { setTimeout as wait } from "node:timers/promises";

const metadataSchema = z.object({
  name: z.string(),
  version: z.string().max(80),
  gitHead: z.string(),
  dist: z.object({ integrity: z.string(), tarball: z.string() }),
});

export async function boundedDownload(
  url: string,
  signal: AbortSignal,
  maximum: number,
): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body)
    throw new CaptureFailure("Registry artifact or metadata unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new CaptureFailure("Registry response exceeds size limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export const registryBoundary: RegistryBoundary = {
  now: Date.now,
  wait: async (ms) => {
    await wait(ms);
  },
  lookup: async (version, signal) => {
    const base = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
    const latest = await boundedDownload(`${base}/latest`, signal, 1_048_576);
    const latestParsed = metadataSchema.safeParse(JSON.parse(latest.toString("utf8")));
    if (!latestParsed.success) throw new CaptureFailure("Invalid stable registry metadata.");
    const response = await fetch(`${base}/${encodeURIComponent(version)}`, {
      signal,
      redirect: "error",
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { latest: latestParsed.data.version, metadata: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CaptureFailure("Exact registry metadata unavailable.");
    }
    // Reuse the bounded reader without issuing another request.
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new CaptureFailure("Empty exact registry metadata.");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1_048_576) {
        await response.body.cancel().catch(() => {});
        throw new CaptureFailure("Registry metadata exceeds size limit.");
      }
      chunks.push(chunk);
    }
    const parsed = metadataSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new CaptureFailure("Invalid exact registry metadata.");
    return { latest: latestParsed.data.version, metadata: parsed.data };
  },
};
