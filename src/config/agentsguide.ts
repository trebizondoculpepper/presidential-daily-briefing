/**
 * The managed pdb coordination section of a project's AGENTS.md (#351,
 * doc/design/agent-onboarding.md "Explicit persistent section").
 *
 * Writes only the verified root's AGENTS.md (or an existing differently cased agents.md, never
 * a second copy), and only the block between the pdb coordination markers, through the locked
 * atomic writer (#382). Bytes outside the block are preserved; an identical block is a no-op.
 * Missing, duplicate or misordered markers, or an existing unmarked pdb section, are refused
 * rather than repaired. Symbolic links are refused.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { COORDINATION_END, COORDINATION_START } from "../briefing/onboarding.js";
import { updateTextFile, type UpdateOptions, type WriteOutcome } from "./safejson.js";

export type InstallOutcome =
  | (WriteOutcome & { file: string })
  | { status: "not-written"; reason: string; cleanup: string[]; file: string | null };

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** An existing pdb section someone wrote by hand, without the markers. */
const unmarkedSection = /^#{1,6}\s.*(presidential daily briefing|\bpdb\b)/im;

/**
 * The new file text with `section` installed, or why it cannot be installed safely. Pure, so the
 * marker rules are testable without a filesystem.
 */
export function withCoordinationSection(
  text: string | null,
  section: string,
): { text: string } | { unchanged: true } | { refuse: string } {
  if (text === null) return { text: `${section}\n` };
  const starts = count(text, COORDINATION_START);
  const ends = count(text, COORDINATION_END);
  if (starts === 0 && ends === 0) {
    if (unmarkedSection.test(text))
      return {
        refuse:
          "it already has a pdb section without the coordination markers; put " +
          `${COORDINATION_START} and ${COORDINATION_END} around it (or remove it), then retry`,
      };
    const separator =
      text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${text}${separator}${section}\n` };
  }
  const start = text.indexOf(COORDINATION_START);
  const end = text.indexOf(COORDINATION_END);
  if (starts !== 1 || ends !== 1 || end < start)
    return {
      refuse: `its pdb coordination markers are missing, duplicated or out of order (${starts} start, ${ends} end); fix them by hand, then retry`,
    };
  const existing = text.slice(start, end + COORDINATION_END.length);
  if (existing === section) return { unchanged: true };
  return { text: text.slice(0, start) + section + text.slice(end + COORDINATION_END.length) };
}

/**
 * Install or update the section in the verified project root's AGENTS.md. `root` must already be
 * the verified Git working-tree root of the selected repository.
 */
export async function installCoordinationSection(
  root: string,
  section: string,
  options: UpdateOptions = {},
): Promise<InstallOutcome> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.toLowerCase() === "agents.md");
  } catch {
    return {
      status: "not-written",
      reason: "the project root cannot be listed",
      cleanup: [],
      file: null,
    };
  }
  // Never create a second, differently cased copy; never pick between two.
  if (names.length > 1)
    return {
      status: "not-written",
      reason: `both ${names.join(" and ")} exist; keep one, then retry`,
      cleanup: [],
      file: null,
    };
  const file = names[0] ?? "AGENTS.md";
  const path = join(root, file);
  try {
    if ((await lstat(path)).isSymbolicLink())
      return {
        status: "not-written",
        reason: `${file} is a symbolic link; pdb does not write through links`,
        cleanup: [],
        file,
      };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT")
      return { status: "not-written", reason: `${file} cannot be inspected`, cleanup: [], file };
  }
  const outcome = await updateTextFile(
    path,
    (current) => {
      if (current.state === "unreadable") return { refuse: `${file} ${current.why}` };
      const next = withCoordinationSection(current.state === "text" ? current.text : null, section);
      if ("refuse" in next) return { refuse: `${file} was not changed: ${next.refuse}` };
      if ("unchanged" in next) return { keep: `${file} already has the current pdb section` };
      return { write: next.text };
    },
    options,
  );
  return { ...outcome, file };
}
