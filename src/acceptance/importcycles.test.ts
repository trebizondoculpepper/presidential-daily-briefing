/**
 * Pins the import cycles listed in doc/design/source-layout.md ("Existing import cycles", #436).
 *
 * Every strongly connected group of non-test modules under src/ must be one of the known groups
 * below, or a subset of one. A new group, or a module joining a known group, fails with the
 * modules involved. When a cycle is broken, shrink or delete its entry here and in the contract,
 * so the list can only tighten.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Known groups, as module paths relative to src/ without the extension. */
const known: string[][] = [
  ["github/dependencies", "github/github"],
  ["estimation/complexitylabels", "estimation/estimate", "estimation/estimation"],
  // reviewevidence imports prstatus for types only.
  ["workflow/prstatus", "workflow/reviewevidence"],
  // pdb serve (#373): the serve/* modules import types from serve.ts; #445 breaks it.
  ["serve", "serve/api", "serve/cache", "serve/mcp", "serve/services"],
];

/** Non-test TypeScript modules: no tests, no declaration files, nothing from src/testing/. */
const modules = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join(src, "testing") ? [] : modules(path);
    return entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });

const name = (file: string) => relative(src, file).split(sep).join("/").replace(/\.ts$/, "");

/** Relative static, re-export, side-effect and `import()` specifiers, type-only ones included. */
const imports = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  const targets = new Set<string>();
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = join(dirname(file), match[1]).replace(/\.js$/, ".ts");
    if (target.endsWith(".ts") && existsSync(target)) targets.add(target);
  }
  return [...targets];
};

/** Tarjan's algorithm: the strongly connected groups with more than one module. */
export const cycleGroups = (graph: Map<string, string[]>): string[][] => {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) === index.get(node)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== node);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node);
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
};

/** Groups that are not contained in a single known group, with the modules that are new. */
export const unexpected = (groups: string[][], allowed: string[][]) =>
  groups
    .filter((group) => !allowed.some((k) => group.every((m) => k.includes(m))))
    .map((group) => {
      const closest = allowed.find((k) => group.some((m) => k.includes(m)));
      return { group, added: closest ? group.filter((m) => !closest.includes(m)) : group };
    });

describe("import cycles (doc/design/source-layout.md, #436)", () => {
  const files = modules(src);
  const graph = new Map(files.map((f) => [name(f), imports(f).map(name)]));
  const groups = cycleGroups(graph);

  it("adds no import cycle and grows no known one", () => {
    const problems = unexpected(groups, known).map(
      ({ group, added }) =>
        `cycle {${group.join(", ")}}: new module(s) ${added.join(", ")} — break the import ` +
        `rather than extend the cycle (see doc/design/source-layout.md, "Existing import cycles")`,
    );
    expect(problems).toEqual([]);
  });

  it("keeps the pinned list tight: every known group still exists in full", () => {
    // A broken or shrunken cycle is good news; update `known` and the contract to match.
    const stale = known.filter((k) => !groups.some((g) => g.join() === [...k].sort().join()));
    expect(stale, "update `known` and source-layout.md to the measured groups").toEqual([]);
  });

  it("reads imports of every form", () => {
    expect(graph.size).toBeGreaterThan(50);
    // Type-only and `import()` edges count: they are part of the cycles the contract lists.
    expect(graph.get("workflow/reviewevidence")).toContain("workflow/prstatus");
    expect(graph.get("briefing/service")).toContain("rules/datalog/datalog");
  });

  it("detects a new group and a module joining a known one", () => {
    const g = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", ["b"]],
      ["x", ["y"]],
      ["y", ["x"]],
      ["z", []],
    ]);
    expect(cycleGroups(g)).toEqual([
      ["a", "b", "c"],
      ["x", "y"],
    ]);
    expect(unexpected(cycleGroups(g), [["a", "b"]])).toEqual([
      { group: ["a", "b", "c"], added: ["c"] },
      { group: ["x", "y"], added: ["x", "y"] },
    ]);
    expect(unexpected([["a", "b"]], [["a", "b", "c"]])).toEqual([]);
  });
});
