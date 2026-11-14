/**
 * Build-time EDN reading for the rules component (doc/design/rules-component.md).
 *
 * Never imported by the engine at runtime: DataScript reads its own query strings. This reader
 * exists so the build can reject sources DataScript would misread silently, such as a second
 * top-level form (DataScript's `read-string` ignores everything after the first form).
 */
import { parseEDNString } from "edn-data";

/** A source problem located in a file; line and column are 1-based. */
export class EdnSourceError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    detail: string,
  ) {
    super(`${file}:${line}:${column}: ${detail}`);
  }
}

const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Finds the first unbalanced delimiter, skipping strings, character literals and comments.
 * Returns null when every delimiter is balanced.
 */
export function locateImbalance(
  text: string,
): { line: number; column: number; detail: string } | null {
  const stack: { open: string; line: number; column: number }[] = [];
  let line = 1,
    column = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    column++;
    if (ch === "\n") {
      line++;
      column = 0;
      continue;
    }
    if (ch === ";") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "\\") {
      i++;
      column++;
      continue;
    }
    if (ch === '"') {
      const start = { line, column };
      let closed = false;
      while (++i < text.length) {
        column++;
        if (text[i] === "\\") {
          i++;
          column++;
        } else if (text[i] === "\n") {
          line++;
          column = 0;
        } else if (text[i] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return { ...start, detail: "unterminated string" };
      continue;
    }
    if (ch in closers) stack.push({ open: ch, line, column });
    else if (ch === ")" || ch === "]" || ch === "}") {
      const top = stack.pop();
      if (!top) return { line, column, detail: `unexpected '${ch}'` };
      if (closers[top.open] !== ch)
        return {
          line,
          column,
          detail: `'${ch}' does not close '${top.open}' opened at ${top.line}:${top.column}`,
        };
    }
  }
  const open = stack.pop();
  return open
    ? { line: open.line, column: open.column, detail: `'${open.open}' is never closed` }
    : null;
}

/**
 * Reads text that must contain exactly one top-level EDN form. Anything else is an error with
 * a location: a missing form, an extra form, or an unbalanced or unreadable form.
 */
export function readOne(text: string, file: string): unknown {
  const imbalance = locateImbalance(text);
  if (imbalance) throw new EdnSourceError(file, imbalance.line, imbalance.column, imbalance.detail);
  let forms: unknown;
  try {
    // Wrapping in a vector reads every top-level form, so extra forms cannot be dropped silently.
    forms = parseEDNString(`[${text}\n]`);
  } catch (error) {
    throw new EdnSourceError(
      file,
      1,
      1,
      `unreadable EDN: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(forms))
    throw new EdnSourceError(file, 1, 1, "unreadable EDN: the reader returned no forms");
  if (forms.length !== 1)
    throw new EdnSourceError(
      file,
      1,
      1,
      `expected exactly one top-level form, found ${forms.length}`,
    );
  return forms[0];
}

/**
 * Prints a value back as canonical EDN for DataScript: single spaces, no comments. Anything the
 * policy does not use, and anything the reader cannot represent faithfully, is rejected rather
 * than guessed: nil, tagged literals such as #inst, characters and non-integer numbers.
 */
export function printEdn(value: unknown, where: string): string {
  const fail = (detail: string): never => {
    throw new Error(`${where}: ${detail}`);
  };
  const print = (v: unknown): string => {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number")
      return Number.isSafeInteger(v) ? String(v) : fail(`unsupported number ${v}`);
    if (v === null) return fail("nil is not supported in policy sources");
    if (Array.isArray(v)) return `[${v.map(print).join(" ")}]`;
    if (typeof v === "object") {
      if ("sym" in v && typeof v.sym === "string") return v.sym;
      if ("key" in v && typeof v.key === "string") return `:${v.key}`;
      if ("list" in v && Array.isArray(v.list)) return `(${v.list.map(print).join(" ")})`;
      if ("set" in v && Array.isArray(v.set)) return `#{${v.set.map(print).join(" ")}}`;
      if ("map" in v && Array.isArray(v.map))
        return `{${(v.map as unknown[][]).map(([k, x]) => `${print(k)} ${print(x)}`).join(" ")}}`;
    }
    return fail(`unsupported EDN value ${JSON.stringify(v)}`);
  };
  return print(value);
}
