/** Full static project-policy compilation (#514), never activation or query execution. */
import { createHash } from "node:crypto";
import { printEdn } from "../edn.js";
import { clauseEdn } from "../english.js";
import { compileProjectGrammar } from "./grammar.js";
import { validateGrounding } from "./grounding.js";
import { readProjectSource, projectRulesFile } from "./source.js";
import type { BaseIdentity, ProjectSourceIO } from "./source.js";
import type { ProjectGrammar, ProjectPreference } from "./grammar.js";
export interface CompiledProjectPreference {
  id: string;
  purpose?: string;
  /** The admitted actions satisfying `:when` alone; each must then bind exactly one priority. */
  matchQuery: string;
  query: string;
  why: string;
  witnesses: Record<string, string>;
  /** The same clauses that generated query, retained for controlled English output. */
  english: Pick<ProjectPreference, "when" | "priority" | "witnesses">;
}
export interface CompiledProjectPolicy {
  phase: "validated-project-policy";
  sourceFile: typeof projectRulesFile;
  formatVersion: 1 | 2;
  projectionVersion: 1;
  basePolicyVersion: number;
  defaultRulesHash: string;
  projectRulesHash: string;
  effectiveRulesHash: string;
  canonicalSource: string;
  rules: string;
  preferences: CompiledProjectPreference[];
  helpers: ProjectGrammar["helpers"];
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const body = (cs: Parameters<typeof clauseEdn>[0][]) => cs.map(clauseEdn).join(" ");
export function compileProjectPolicy(text: string, base: BaseIdentity): CompiledProjectPolicy {
  const grammar = compileProjectGrammar(text, base);
  validateGrounding(grammar);
  const source = grammar.source;
  return {
    phase: "validated-project-policy",
    sourceFile: projectRulesFile,
    formatVersion: source.formatVersion,
    projectionVersion: 1,
    basePolicyVersion: source.basePolicyVersion,
    defaultRulesHash: source.baseRulesHash,
    projectRulesHash: source.sourceDigest,
    effectiveRulesHash: digest(
      JSON.stringify([source.formatVersion, source.baseRulesHash, 1, source.canonicalSource]),
    ),
    canonicalSource: source.canonicalSource,
    rules: printEdn(source.rules, "pdb.rules.edn :rules"),
    helpers: grammar.helpers,
    preferences: grammar.preferences.map((p) => ({
      id: p.id,
      ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
      why: p.why,
      matchQuery: `[:find ?a :in $ % :where [?a "pdb.action-id" _] ${body(p.when)}]`,
      // Fix the initial action domain; #515 must still validate every returned action identity.
      query: `[:find ?a ?value :in $ % :where [?a "pdb.action-id" _] ${body(p.when)} ${body(p.priority)}]`,
      witnesses: Object.fromEntries(
        Object.entries(p.witnesses).map(([name, cs]) => [
          name,
          `[:find ?value :in $ % ?a :where ${body(cs)}]`,
        ]),
      ),
      english: { when: p.when, priority: p.priority, witnesses: p.witnesses },
    })),
  };
}

/** Compose selected-file I/O and static validation; still no activation/evaluation. */
export async function loadProjectPolicy(
  projectRoot: string,
  base: BaseIdentity,
  io?: ProjectSourceIO,
): Promise<CompiledProjectPolicy> {
  const source = await readProjectSource(projectRoot, base, io);
  return compileProjectPolicy(source.canonicalSource, base);
}
