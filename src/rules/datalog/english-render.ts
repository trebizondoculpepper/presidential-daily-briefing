/**
 * Renders compiled clauses (english-model.ts) as controlled English. Pure and runtime-safe: it
 * reads only the model, never EDN. Predicate and variable names stay visible; attribute words
 * come from the lexicon phrase each fact carries. Negation reads as "no match for", which is
 * what DataScript evaluates, so absent evidence never reads as a positive claim.
 */
import type { Clause, Term } from "./english-model.js";

export const termText = (t: Term): string =>
  "var" in t
    ? t.var
    : "wild" in t
      ? "anything"
      : typeof t.lit === "string"
        ? JSON.stringify(t.lit)
        : String(t.lit);

const comparisonWords: Record<string, string> = {
  "=": "=",
  "not=": "is not",
  "<": "<",
  ">": ">",
  "<=": "≤",
  ">=": "≥",
};

function factText(c: Extract<Clause, { type: "fact" }>): string {
  const v = termText(c.value);
  const wild = "wild" in c.value;
  switch (c.scope) {
    case "viewer":
      return wild ? `the viewer has a ${c.phrase}` : `the viewer's ${c.phrase} is ${v}`;
    case "constant":
      return wild
        ? `the constant set "${c.attribute}" is not empty`
        : `${v} is in the constant set "${c.attribute}"`;
    case "context":
      return wild ? `the context records some ${c.phrase}` : `the context records ${c.phrase} ${v}`;
    case "entity": {
      const e = termText(c.entity);
      if (wild) return `${e} has some ${c.phrase}`;
      return c.many ? `${e} has ${c.phrase} ${v}` : `${e}'s ${c.phrase} is ${v}`;
    }
  }
}

/** One clause on one line; nested groups are inlined. */
export function clauseText(c: Clause): string {
  switch (c.type) {
    case "fact":
      return factText(c);
    case "call":
      return `${c.predicate}(${c.args.map(termText).join(", ")})`;
    case "compare": {
      // Every operand is shown. Clojure compares a chain pairwise (a < b < c), and not= with
      // several operands means they are not all equal. The compiler rejects other shapes; this
      // throws rather than print a partial condition if one ever reaches it.
      const word = comparisonWords[c.op];
      const args = c.args.map(termText);
      if (!word || args.length < 2)
        throw new Error(`cannot render comparison ${c.op} with ${args.length} operand(s)`);
      if (c.op === "not=")
        return args.length === 2
          ? `${args[0]} is not ${args[1]}`
          : `not all of ${args.join(", ")} are equal`;
      return args.join(` ${word} `);
    }
    case "bind":
      if (c.fn === "str" && !c.args.length) throw new Error("cannot render str with no operands");
      if (c.fn === "str")
        return c.args.length === 1
          ? `${c.result} is the text ${termText(c.args[0])}`
          : `${c.result} is the text joining ${c.args.map(termText).join(", ")}`;
      if (c.args.length < 2)
        throw new Error(`cannot render ${c.fn} with ${c.args.length} operand(s)`);
      return `${c.result} = ${c.args.map(termText).join(` ${c.fn} `)}`;
    case "not":
      return `no match${joinText(c.join)} for: ${conjunctionText(c.body)}`;
    case "or":
      if (c.alternatives.length === 1) return `(${conjunctionText(c.alternatives[0])})`;
      return `at least one of${joinText(c.join)}: ${c.alternatives
        .map((alt, i) => `(${i + 1}) ${conjunctionText(alt)}`)
        .join("; ")}`;
  }
}

const joinText = (join: string[] | null) => (join ? ` (joined on ${join.join(", ")})` : "");

export const conjunctionText = (clauses: Clause[]): string =>
  clauses.length ? clauses.map(clauseText).join(" and ") : "always";

/**
 * Clauses as indented lines, one clause per line; `not` and multi-alternative `or` groups put
 * their bodies on nested lines so long conditions stay readable without losing grouping.
 */
export function clauseLines(clauses: Clause[], indent = "  "): string[] {
  const lines: string[] = [];
  for (const c of clauses) {
    if (c.type === "not" && c.body.length > 1) {
      lines.push(`${indent}- no match${joinText(c.join)} for all of:`);
      lines.push(...clauseLines(c.body, `${indent}    `));
    } else if (c.type === "or" && c.alternatives.length > 1) {
      lines.push(`${indent}- at least one of${joinText(c.join)}:`);
      c.alternatives.forEach((alt, i) => {
        lines.push(`${indent}    (${i + 1}) all of:`);
        lines.push(...clauseLines(alt, `${indent}        `));
      });
    } else lines.push(`${indent}- ${clauseText(c)}`);
  }
  return lines;
}

/** A predicate head with the given alternative's own variables, e.g. `blocked(?t)`. */
export const predicateHead = (name: string, params: string[]): string =>
  `${name}(${params.join(", ")})`;
