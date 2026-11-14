/**
 * Minimal EDN reader for the #336 rule-testing example (doc/reports/rule-testing-recommendation.md).
 *
 * Research example only: it reads the subset the scenario files use (maps, vectors, lists, sets,
 * keywords, strings, integers, booleans, nil and `;` comments) and records the source line of
 * every map, so a failing scenario can name `file:line`. A production runner would use a
 * maintained parser such as `edn-data`, which has no source positions, and recover a scenario's
 * line by its unique `:id` instead.
 */
export type Edn =
  | null
  | boolean
  | number
  | string
  | { keyword: string }
  | Edn[]
  | { set: Edn[] }
  | Map<Edn, Edn>;

/** Source line (1-based) of each map the reader produced. */
export const mapLines = new WeakMap<Map<Edn, Edn>, number>();

/** A syntax error: always an infrastructure failure, never a rule failure. */
export class EdnSyntaxError extends Error {
  override name = "EdnSyntaxError";
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line}: ${detail}`);
  }
}

export const keyword = (name: string): { keyword: string } => ({ keyword: name });
export const isKeyword = (v: unknown, name?: string): v is { keyword: string } =>
  typeof v === "object" &&
  v !== null &&
  "keyword" in v &&
  (name === undefined || (v as { keyword: string }).keyword === name);

/** Keyword-keyed map lookup, since EDN keyword keys are objects rather than strings. */
export function get(map: Map<Edn, Edn>, key: string): Edn | undefined {
  for (const [k, v] of map) if (isKeyword(k, key)) return v;
  return undefined;
}

export function readEdn(text: string, file: string): Edn {
  let i = 0;
  let line = 1;
  const fail = (detail: string): never => {
    throw new EdnSyntaxError(file, line, detail);
  };
  const skip = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") line++;
      if (c === ";") while (i < text.length && text[i] !== "\n") i++;
      else if (/[\s,]/.test(c)) i++;
      else break;
    }
  };
  const until = (close: string): Edn[] => {
    const items: Edn[] = [];
    for (;;) {
      skip();
      if (i >= text.length) fail(`unexpected end of input, expected ${close}`);
      if (text[i] === close) {
        i++;
        return items;
      }
      items.push(value());
    }
  };
  const value = (): Edn => {
    skip();
    const c = text[i];
    if (c === undefined) return fail("unexpected end of input");
    if (c === "[" || c === "(") {
      i++;
      return until(c === "[" ? "]" : ")");
    }
    if (c === "#" && text[i + 1] === "{") {
      i += 2;
      return { set: until("}") };
    }
    if (c === "{") {
      const start = line;
      i++;
      const items = until("}");
      if (items.length % 2) fail("map literal has an odd number of forms");
      const map = new Map<Edn, Edn>();
      for (let k = 0; k < items.length; k += 2) map.set(items[k], items[k + 1]);
      mapLines.set(map, start);
      return map;
    }
    if (c === '"') {
      let s = "";
      i++;
      while (text[i] !== '"') {
        if (i >= text.length) fail("unterminated string");
        if (text[i] === "\\") {
          i++;
          const escaped = (
            { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" } as Record<string, string>
          )[text[i]];
          // EDN defines \t \r \n \\ and \"; anything else is outside this reader, not dropped.
          if (escaped === undefined) fail(`unsupported string escape \\${text[i] ?? ""}`);
          s += escaped;
        } else {
          if (text[i] === "\n") line++;
          s += text[i];
        }
        i++;
      }
      i++;
      return s;
    }
    const token = /^[^\s,()[\]{}";]+/.exec(text.slice(i))?.[0];
    if (!token) return fail(`unexpected character ${JSON.stringify(c)}`);
    i += token.length;
    if (token.startsWith(":")) return keyword(token.slice(1));
    if (token === "nil") return null;
    if (token === "true" || token === "false") return token === "true";
    if (/^-?\d+$/.test(token)) return Number(token);
    return fail(`unsupported token ${token}`);
  };
  const result = value();
  skip();
  if (i < text.length) fail("trailing content after the top-level form");
  return result;
}
