/** Literal presentation metadata shared by bundled and project rule source validation (#578). */
export const purposeLimit = 320;

/** Purposes never interpolate witnesses, evaluate templates or interpret markup. */
export function purposeText(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > purposeLimit ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || [127, 133, 8232, 8233].includes(c.charCodeAt(0)),
    )
  )
    throw new Error(
      `${where}: purpose must be nonempty single-line text of at most ${purposeLimit} characters`,
    );
  return value;
}
