import { CaptureFailure } from "./failure.js";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export interface SanitizedText {
  text: string;
  sha256: string;
  terminalControlsRemoved: boolean;
  redactions: string[];
}
/** This is exposure defense, not permission to collect private data. Never return raw failures. */
export function sanitizeOutput(
  raw: string,
  options: { sensitiveValues: string[]; controlledPaths: string[]; privateIdentities: string[] },
): SanitizedText {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
    throw new CaptureFailure("Command output exceeds 2 MiB.");
  // eslint-disable-next-line no-control-regex -- Remove non-printing C0/C1 terminal effects.
  let text = stripVTControlCharacters(raw).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const terminalControlsRemoved = text !== raw;
  for (const secret of options.sensitiveValues) {
    if (secret && (raw.includes(secret) || text.includes(secret)))
      throw new CaptureFailure("Sensitive output discarded.");
  }
  if (
    /https?:\/\/[^\s/]+:[^\s/]+@/i.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|sksonauto__[A-Za-z0-9_-]{16,})\b/i.test(
      text,
    ) ||
    /(?:authorization\s*:\s*(?:bearer|token)\s+\S+|(?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|API[_-]?KEY|PASSWORD)\s*[=:]\s*\S+)/i.test(
      text,
    )
  ) {
    throw new CaptureFailure("Credential-shaped output discarded.");
  }
  for (const identity of options.privateIdentities) {
    if (identity && text.includes(identity))
      throw new CaptureFailure("Private identity output discarded.");
  }
  const redactions: string[] = [];
  // Longest first prevents a shorter prefix from hiding a longer private path.
  for (const path of [...options.controlledPaths].sort((a, b) => b.length - a.length)) {
    if (path && text.includes(path)) {
      text = text.replaceAll(path, "[capture-workspace]");
      if (!redactions.includes("capture workspace path")) redactions.push("capture workspace path");
    }
  }
  if (/(?:\/(?:Users|home|private|tmp|var\/folders)\/|[A-Za-z]:[\\/]Users[\\/])/i.test(text)) {
    throw new CaptureFailure("Unexpected private path output discarded.");
  }
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    terminalControlsRemoved,
    redactions,
  };
}
