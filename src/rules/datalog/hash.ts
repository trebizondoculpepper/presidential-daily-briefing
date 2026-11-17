import { createHash } from "node:crypto";
import type { PolicyBundle } from "./bundle.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Preserve every legacy hash input; newly added literal purposes have a separate revision. */
export function rulesHashOf(bundle: PolicyBundle): string {
  const { denialPurposes: _purposes, ...policy } = bundle;
  policy.definitions = policy.definitions.map(({ purpose: _purpose, ...definition }) => definition);
  return digest(policy);
}

/** Binds authored purposes, including gaps, to the exact compatible native policy revision. */
export function narrationHashOf(bundle: PolicyBundle): string | null {
  if (
    !bundle.definitions.some((d) => d.purpose !== undefined) &&
    !Object.keys(bundle.denialPurposes ?? {}).length
  )
    return null;
  return digest([
    1,
    rulesHashOf(bundle),
    bundle.definitions.map((d) => [d.id, d.purpose ?? null]),
    Object.keys(bundle.denials).map((id) => [id, bundle.denialPurposes?.[id] ?? null]),
  ]);
}
