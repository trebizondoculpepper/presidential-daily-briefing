import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePolicy, DatalogError, firstSubjectId, maxSubjects } from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Module specifiers of every static and dynamic import or re-export in a TypeScript file. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
}

/** The engine's own files and external modules, following relative imports transitively. */
function closure(entry: string): { files: string[]; external: string[] } {
  const files = new Set<string>(),
    external = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (!file.endsWith(".ts")) return;
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) external.add(spec);
      else visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  visit(entry);
  return {
    files: [...files].map((f) => f.slice(here.length + 1).replaceAll("\\", "/")).sort(),
    external: [...external].sort(),
  };
}

describe("engine boundary (#348)", () => {
  it("imports no host modules: only the policy bundle, DataScript and node:crypto", () => {
    const { files, external } = closure(join(here, "engine.ts"));
    expect(files).toEqual([
      "bundle.ts",
      "check-types.ts",
      "engine.ts",
      "hash.ts",
      "policy.generated.json",
    ]);
    expect(external).toEqual(["datascript", "node:crypto"]);
  });

  it("refuses a host-supplied native check verdict", () => {
    expect(() =>
      evaluatePolicy({
        viewer: { role: "implementer", agent: "", platform: "", order: "impact" },
        datoms: [[100, "native-checks-satisfied", true]],
      }),
    ).toThrow(/cannot be supplied by the host/);
  });
  it("evaluates plain facts without any GitHub snapshot", () => {
    const t = firstSubjectId;
    const result = evaluatePolicy({
      viewer: { role: "implementer", agent: "me", platform: "", order: "impact" },
      datoms: [
        [1, "forward-complete", true],
        [t, "kind", "issue"],
        [t, "state", "OPEN"],
        [t, "number", 7],
        [t, "target", "issue-7"],
        [t, "created", 1],
        [t, "label", "status:ready"],
        [t, "labels-complete", true],
        [t, "native-complete", true],
        [t, "reverse-complete", true],
        [t, "blocking-complete", true],
        [t, "open-blockers", 0],
        [t, "impact-state", "current"],
        [t, "impact-size", "L"],
        [t, "complexity-state", "current"],
        [t, "complexity-size", "S"],
      ],
    });
    expect(result.decisions.map((d) => [d.subject, d.ruleId])).toEqual([[t, "D-EASY"]]);
    expect(result.decisions[0].why.text).toBe("Known easy win: impact L, complexity S.");
  });

  it("rejects facts on reserved policy entities and unsupported roles", () => {
    const viewer = { role: "implementer", agent: "", platform: "", order: "impact" };
    expect(() => evaluatePolicy({ viewer, datoms: [[10, "rule", "D-EASY"]] })).toThrow(
      DatalogError,
    );
    expect(() => evaluatePolicy({ viewer: { ...viewer, role: "owner" }, datoms: [] })).toThrow(
      "unsupported-role",
    );
  });

  it("enforces the subject limit itself, exactly as the adapter does", () => {
    const viewer = { role: "implementer", agent: "", platform: "", order: "impact" };
    const subjects = (n: number) =>
      Array.from({ length: n }, (_, i): [number, string, string] => [
        firstSubjectId + i,
        "kind",
        "issue",
      ]);
    expect(() => evaluatePolicy({ viewer, datoms: subjects(maxSubjects + 1) })).toThrow(
      "experimental-scope-exceeded: at most 500 subjects are supported",
    );
    expect(() => evaluatePolicy({ viewer, datoms: subjects(maxSubjects) })).not.toThrow();
  });
});
