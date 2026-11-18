/**
 * `pdb rules` (#416, doc/design/rules-english-command.md): the represented policy in English.
 *
 * Pure: the compiled model (english.generated.json, written by `npm run rules:build`) and the
 * host's declared defaults and mutation boundary go in; one versioned document comes out, and
 * the text listing is a projection of that same document. Nothing here reads files, the network,
 * GitHub or repository configuration, so it works from the installed package anywhere.
 */
import englishJson from "./english.generated.json" with { type: "json" };
import {
  rulesHash as engineRulesHash,
  narrationHash as engineNarrationHash,
  policyVersion,
} from "./engine.js";
import {
  clauseLines,
  conjunctionText,
  predicateHead,
  queryHeader,
  evidenceLines,
  decisionFormalLines,
  denialFormalLines,
  denialQueryLines,
  preferenceFormalLines,
  decisionGroups,
  mdCode,
  mdEscape,
  mdClauseLines,
  mdDecisionLines,
  mdDenialLines,
  mdPreferenceLines,
} from "./english-render.js";
import type {
  Clause,
  CompiledDecision,
  CompiledDenial,
  CompiledPredicate,
  CompiledQuery,
  EnglishPolicy,
} from "./english-model.js";

/** Version of the `pdb rules --json` document shape. */
export const RULES_SCHEMA_VERSION = 1;
export const RULES_COMMAND = "pdb rules";
/** Roles `--role` accepts, per the contract. */
export const rulesRoles = ["implementer", "designer"] as const;

// Validated by rules:build and `rules:build --check`; JSON types are too wide.
const shipped = englishJson as unknown as EnglishPolicy;

export class RulesArgumentError extends Error {}
export class RulesArtifactError extends Error {}

export interface DeclaredDefault {
  name: string;
  value: string | number | boolean | null;
  /** Where the default is declared, e.g. the configuration registry or the CLI. */
  declaredBy: string;
}
export interface RulesContext {
  defaults: DeclaredDefault[];
  /** Commands that change GitHub; their guards are TypeScript, outside this policy. */
  mutatingCommands: string[];
  /** Related command, cross-linked from the listing. */
  processCommand: string;
  /**
   * The selected project's effective settings, when a caller has verified and read them (the
   * serve rules page, #392). Absent means unknown: defaults are never presented as effective.
   */
  effective?: EffectiveSettings;
  /**
   * The selected project's native preferences (#516), when a caller resolved them. Absent means
   * unknown: a default-only listing is never presented as the effective policy.
   */
  project?: ProjectRulesView;
}

/** The parts of a validated project policy the English document renders (#514 models). */
export interface ProjectPolicyEnglish {
  formatVersion: number;
  projectionVersion: number;
  basePolicyVersion: number;
  projectRulesHash: string;
  effectiveRulesHash: string;
  preferences: {
    id: string;
    purpose?: string;
    why: string;
    english: { when: Clause[]; priority: Clause[]; witnesses: Record<string, Clause[]> };
  }[];
  helpers: { name: string; params: string[]; clauses: Clause[] }[];
}
/** What is known about the selected project's native preferences. */
export type ProjectRulesView =
  | { state: "disabled"; reason: string }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string; next: string[] }
  | { state: "active"; policy: ProjectPolicyEnglish };
/** Fixed facts about how project preferences apply; from projection.ts and worker.ts. */
export interface ProjectLimits {
  protectedBands: number[];
  actions: number;
  datoms: number;
  evaluationMs: number;
  startupMs: number;
  lexicon: { viewer: Record<string, string>; attributes: Record<string, string> };
}

/** One effective repository setting as read from a verified local checkout. */
export interface EffectiveSettingValue {
  name: string;
  value: string | number | boolean | null;
  /** "explicit": stored in the settings file; "default": nothing stored, the registry default applies. */
  source: "explicit" | "default";
}
export type EffectiveSettings =
  | {
      status: "known";
      repository: string;
      /** Repository-relative settings file read, or a note that none exists. */
      readFrom: string;
      settings: EffectiveSettingValue[];
    }
  | { status: "unknown"; reason: string };
export interface RulesFilters {
  rule?: string;
  role?: string;
}

interface UsedBy {
  decisions: string[];
  denials: string[];
  predicates: string[];
  queries: string[];
}

/**
 * The shipped model, after checking it was compiled from the very policy the engine runs. A
 * mismatch means a stale or mixed install, and printing it would misstate the rules.
 */
export interface RulesArtifactIdentity {
  rulesHash: string;
  policyVersion: number;
  narrationHash?: string | null;
}

/** Both identities are checked; absence is compatible only with matching absent narration. */
export function validateRulesArtifact(
  model: EnglishPolicy,
  native: RulesArtifactIdentity,
): EnglishPolicy {
  if (model.rulesHash !== native.rulesHash || model.policyVersion !== native.policyVersion)
    throw new RulesArtifactError(
      `the English rules artifact (rulesHash ${model.rulesHash.slice(0, 12)}) does not match the engine policy (rulesHash ${native.rulesHash.slice(0, 12)}); reinstall pdb or run npm run rules:build`,
    );
  const revision = model.narrationHash ?? null;
  const unboundPurpose =
    revision === null &&
    [...model.decisions, ...model.denials].some((r) => r.purpose !== undefined);
  if (revision !== (native.narrationHash ?? null) || unboundPurpose)
    throw new RulesArtifactError(
      "the English narration revision does not match the native policy; reinstall pdb or run npm run rules:build",
    );
  return model;
}
export function shippedModel(model: EnglishPolicy = shipped): EnglishPolicy {
  return validateRulesArtifact(model, {
    rulesHash: engineRulesHash,
    policyVersion,
    narrationHash: engineNarrationHash,
  });
}

/** Every rule ID and predicate name `--rule` accepts. */
export function ruleIds(model: EnglishPolicy): string[] {
  return [
    ...model.decisions.map((d) => d.id),
    ...model.denials.map((d) => d.id),
    ...model.predicates.map((p) => p.name),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

/** Predicate calls anywhere in the clauses, nested groups included. */
function callsIn(clauses: Clause[]): string[] {
  return clauses.flatMap((c) =>
    c.type === "call"
      ? [c.predicate]
      : c.type === "not" || c.type === "and"
        ? callsIn(c.body)
        : c.type === "or"
          ? c.alternatives.flatMap(callsIn)
          : [],
  );
}

/** Predicates reachable from `roots` through calls, in glossary order; cycles stop naturally. */
function closure(model: EnglishPolicy, roots: string[]): Set<string> {
  const byName = new Map(model.predicates.map((p) => [p.name, p]));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.calls ?? []));
  }
  return seen;
}

function usedByIndex(model: EnglishPolicy): Map<string, UsedBy> {
  const index = new Map<string, UsedBy>(
    model.predicates.map((p) => [
      p.name,
      { decisions: [], denials: [], predicates: [], queries: [] },
    ]),
  );
  const add = (calls: string[], key: keyof UsedBy, who: string) => {
    for (const c of calls) {
      const list = index.get(c)?.[key];
      if (list && !list.includes(who)) list.push(who);
    }
  };
  for (const d of model.decisions) add(d.calls, "decisions", d.id);
  for (const d of model.denials) add(d.calls, "denials", d.id);
  for (const p of model.predicates) add(p.calls, "predicates", p.name);
  for (const q of [
    ...model.ordering.overrideQueries,
    model.ordering.sortQuery,
    ...model.ordering.keyQueries,
    ...model.queries,
  ])
    add(q.calls, "queries", q.name);
  return index;
}

/** Suggestions for an unknown `--rule` value: same prefix or substring, case-insensitive. */
function suggestions(model: EnglishPolicy, wanted: string): string[] {
  const w = wanted.toLowerCase();
  return ruleIds(model)
    .filter((id) => id.toLowerCase().includes(w) || w.includes(id.toLowerCase()))
    .slice(0, 8);
}

/**
 * The versioned document. Filters only ever remove whole decisions, denials, predicates and
 * queries; whatever remains is complete, and the scope says what was selected and that it is a
 * subset. A rule names a role only through a top-level viewer role fact; any other rule is kept
 * for every role, because its role conditions cannot be decided without facts.
 */
export function rulesDocument(
  context: RulesContext,
  filters: RulesFilters = {},
  model: EnglishPolicy = shippedModel(),
  projectLimits?: ProjectLimits,
) {
  const active = context.project?.state === "active" ? context.project.policy : null;
  const projectIds = active
    ? [...active.preferences.map((p) => p.id), ...active.helpers.map((h) => h.name)]
    : [];
  if (filters.role !== undefined && !(rulesRoles as readonly string[]).includes(filters.role))
    throw new RulesArgumentError(
      `--role must be ${rulesRoles.join(" or ")}, not "${filters.role}"`,
    );
  const projectSelected = filters.rule !== undefined && projectIds.includes(filters.rule);
  if (filters.rule !== undefined && !projectSelected && !ruleIds(model).includes(filters.rule)) {
    const near = [
      ...projectIds.filter((id) => id.includes(filters.rule!.toLowerCase())),
      ...suggestions(model, filters.rule),
    ].slice(0, 8);
    throw new RulesArgumentError(
      `unknown rule or predicate "${filters.rule}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Decision IDs, denial IDs, predicate names and, for an active project policy, its preference and helper names are accepted; ${RULES_COMMAND} --json lists them all.`,
    );
  }
  const usedBy = usedByIndex(model);
  const filtered = filters.rule !== undefined || filters.role !== undefined;

  let decisions: CompiledDecision[] = model.decisions;
  if (filters.role)
    decisions = decisions.filter(
      (d) => d.roles === null || d.roles.includes(filters.role as string),
    );
  let denials: CompiledDenial[] = model.denials;
  let predicates: CompiledPredicate[] = model.predicates;
  let queries: CompiledQuery[] = model.queries;
  let keyQueries: CompiledQuery[] = model.ordering.keyQueries;
  let overrides = model.ordering.overrides;
  let selected: {
    id: string;
    type: "decision" | "denial" | "predicate";
  } | null = null;

  if (projectSelected) {
    // A project preference or helper: no default rule is selected, only the project's own.
    decisions = [];
    denials = [];
    predicates = [];
    queries = [];
    keyQueries = [];
    overrides = [];
  } else if (filters.rule !== undefined) {
    const id = filters.rule;
    const decision = decisions.find((d) => d.id === id);
    const denial = model.denials.find((d) => d.id === id);
    const allDecisions = decisions;
    if (decision) {
      selected = { id, type: "decision" };
      // Precedence context: rules of the same kind (the generic override compares only these)
      // and every declared override naming this rule.
      overrides = overrides.filter((o) => o.winner === id || o.loser === id);
      const related = new Set([
        id,
        ...allDecisions.filter((d) => d.kind === decision.kind).map((d) => d.id),
        ...overrides.flatMap((o) => [o.winner, o.loser]),
      ]);
      decisions = allDecisions.filter((d) => related.has(d.id));
      denials = [];
    } else if (denial) {
      selected = { id, type: "denial" };
      decisions = [];
      denials = [denial];
      overrides = [];
    } else if (model.predicates.some((p) => p.name === id)) {
      selected = { id, type: "predicate" };
      decisions = [];
      denials = [];
      overrides = [];
    } else if (filters.role) {
      // A decision that exists but does not apply to the requested role.
      throw new RulesArgumentError(
        `${id} names role(s) ${model.decisions.find((d) => d.id === id)?.roles?.join(", ")}, so --role ${filters.role} excludes it`,
      );
    }
    // The glossary is the transitive closure over everything this view renders: the selected
    // item, the same-kind decisions and override context kept with it, their evidence and the
    // ordering queries, so every predicate named in the output is defined in it (#480 review).
    const contextQueries =
      selected?.type === "decision"
        ? [...model.ordering.overrideQueries, model.ordering.sortQuery, ...keyQueries]
        : [];
    const evidence = selected?.type === "decision" ? model.evidence : [];
    const roots = [
      ...(selected?.type === "predicate" ? [id] : []),
      ...decisions.flatMap((d) => [...d.calls, ...d.evidence.flatMap((e) => callsIn(e.clauses))]),
      ...denials.flatMap((d) => [d.predicate, ...d.calls]),
      ...contextQueries.flatMap((q) => q.calls),
      ...evidence.flatMap((e) => callsIn(e.clauses)),
    ];
    const needed = closure(model, roots);
    predicates = model.predicates.filter((p) => needed.has(p.name));
    queries = [];
    keyQueries = selected?.type === "decision" ? keyQueries : [];
  }

  const decisionOut = decisions.map((d) => ({
    ...d,
    english: conjunctionText(d.clauses),
    overriddenBy: model.ordering.overrides.filter((o) => o.loser === d.id).map((o) => o.winner),
    overrides: model.ordering.overrides.filter((o) => o.winner === d.id).map((o) => o.loser),
  }));
  const predicateOut = predicates.map((p) => ({
    ...p,
    english: p.alternatives.map((a) => conjunctionText(a.clauses)),
    usedBy: usedBy.get(p.name),
  }));
  const queryOut = (q: CompiledQuery) => ({ ...q, english: conjunctionText(q.clauses) });

  // #516: the project's preferences, rendered with the same structural renderer and their own
  // projection lexicon, never merged into the default policy's.
  const project = active
    ? (() => {
        let preferences = active.preferences;
        let helpers = active.helpers;
        if (projectSelected) {
          const id = filters.rule as string;
          preferences = preferences.filter((p) => p.id === id);
          const roots = preferences.length
            ? preferences.flatMap((p) => [
                ...callsIn(p.english.when),
                ...callsIn(p.english.priority),
                ...Object.values(p.english.witnesses).flatMap(callsIn),
              ])
            : [id];
          const byName = new Map(active.helpers.map((h) => [h.name, h]));
          const needed = new Set<string>();
          const queue = [...roots];
          while (queue.length) {
            const name = queue.shift() as string;
            if (needed.has(name)) continue;
            needed.add(name);
            for (const h of active.helpers.filter((x) => x.name === name))
              queue.push(...callsIn(h.clauses));
          }
          helpers = active.helpers.filter((h) => needed.has(h.name) && byName.has(h.name));
        } else if (filters.rule !== undefined) {
          preferences = [];
          helpers = [];
        }
        return {
          source: "pdb.rules.edn",
          preferences: preferences.map((p) => ({
            id: p.id,
            ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
            why: p.why,
            when: conjunctionText(p.english.when),
            priority: conjunctionText(p.english.priority),
            witnesses: Object.fromEntries(
              Object.entries(p.english.witnesses).map(([name, cs]) => [name, conjunctionText(cs)]),
            ),
            clauses: p.english,
          })),
          helpers: helpers.map((h) => ({
            name: h.name,
            params: h.params,
            english: conjunctionText(h.clauses),
            clauses: h.clauses,
          })),
          ...(projectLimits ? { limits: projectLimits } : {}),
          statements: [
            "Project preferences only reorder actions the shipped policy already admitted, within each adjustable band; they never add, remove or re-band an action, or change its kind, role, target or next command.",
            `Protected bands ${projectLimits?.protectedBands.join(" and ") ?? "1 and 2"} (addressed attention and concrete PR follow-up) are never seen or reordered by project rules.`,
            "Within a band, the highest matched project priority sorts first; equal or no priority keeps the shipped order. Default reasons and warnings stay; project reasons are added beside them.",
            "Under an explicit oldest or newest order, project preferences are not applied and the shipped order is kept exactly.",
          ],
        };
      })()
    : null;
  const view = context.project ?? {
    state: "unknown" as const,
    reason:
      "pdb rules was not given a project, so whether project preferences are in force is unknown; this listing is the shipped default policy only.",
  };
  const effectivePolicy = {
    state: view.state,
    source: "pdb.rules.edn",
    defaultRulesHash: model.rulesHash,
    projectRulesHash: active?.projectRulesHash ?? null,
    effectiveRulesHash: active
      ? active.effectiveRulesHash
      : view.state === "disabled"
        ? model.rulesHash
        : null,
    formatVersion: active?.formatVersion ?? null,
    projectionVersion: active?.projectionVersion ?? null,
    basePolicyVersion: active?.basePolicyVersion ?? null,
    reason: view.state === "active" ? null : view.reason,
    next: view.state === "error" ? view.next : [],
  };

  return {
    schemaVersion: RULES_SCHEMA_VERSION,
    command: RULES_COMMAND,
    policy: {
      policyVersion: model.policyVersion,
      rulesHash: model.rulesHash,
      narrationHash: model.narrationHash ?? null,
      englishModelVersion: model.modelVersion,
      sources: model.sources,
    },
    effectivePolicy,
    project,
    scope: {
      complete: !filtered,
      filters: {
        ...(filters.rule !== undefined ? { rule: filters.rule } : {}),
        ...(filters.role !== undefined ? { role: filters.role } : {}),
      },
      selected: projectSelected
        ? {
            id: filters.rule as string,
            type: active!.preferences.some((p) => p.id === filters.rule)
              ? ("project-preference" as const)
              : ("project-helper" as const),
          }
        : selected,
      note: filtered
        ? "Filtered subset of the policy, not the complete rules. Run pdb rules without filters for every rule."
        : "Complete represented policy: every decision rule, denial, ordering rule, query and predicate in the bundled artifact.",
    },
    defaults: {
      declared: context.defaults,
      effective:
        context.effective ??
        ({
          status: "unknown",
          reason:
            "pdb rules reads no project configuration, so this repository's effective settings are not known here and are not assumed to equal the defaults. Use pdb config list inside the project.",
        } as EffectiveSettings),
    },
    narration: {
      scope:
        "Decision rules, denial rules and project preferences in this view; predicates and queries retain formal definitions.",
      total: decisionOut.length + denials.length + (project?.preferences.length ?? 0),
      supplied: [...decisionOut, ...denials, ...(project?.preferences ?? [])].filter(
        (r) => r.purpose !== undefined,
      ).length,
      missing: [...decisionOut, ...denials, ...(project?.preferences ?? [])]
        .filter((r) => r.purpose === undefined)
        .map((r) => r.id),
      note: "Authored purposes explain intent; generated conditions define the represented policy. A purpose is not evidence that a rule matched a ticket. Mutation guards remain outside this listing.",
    },
    decisions: decisionOut,
    eligibility: {
      denials,
      denialQuery:
        filters.rule === undefined
          ? queryOut(model.queries.find((q) => q.name === "denials") as CompiledQuery)
          : null,
    },
    ordering: {
      comparison: model.ordering.comparison,
      overrides,
      overrideQueries:
        filters.rule === undefined || selected?.type === "decision"
          ? model.ordering.overrideQueries.map(queryOut)
          : [],
      sortQuery:
        filters.rule === undefined || selected?.type === "decision"
          ? queryOut(model.ordering.sortQuery)
          : null,
      keyQueries: keyQueries.map(queryOut),
    },
    queries: queries.filter((q) => q.name !== "denials").map(queryOut),
    predicates: predicateOut,
    evidence: filters.rule === undefined || selected?.type === "decision" ? model.evidence : [],
    constants: model.constants,
    lexicon: model.lexicon,
    boundary: {
      mutatingCommands: context.mutatingCommands,
      statements: [
        `Commands that change GitHub (${context.mutatingCommands.join(", ")}) enforce their own guards in TypeScript. Compiling this policy does not prove that every such guard is encoded in Datalog.`,
        "Collecting GitHub evidence and turning it into the input facts named under Inputs happens in TypeScript before the policy runs; it is not shown here.",
        "Runtime explanations (each recommendation's why text) explain individual matches and are not the source of this listing.",
      ],
    },
    coverage: model.coverage,
    related: {
      process: `${context.processCommand} prints the short workflow guide; ${RULES_COMMAND} prints the compiled policy. Neither replaces the other.`,
    },
  };
}
export type RulesDocument = ReturnType<typeof rulesDocument>;

/** Markdown formal CLI listing (#1049, doc/design/markdown-rules.md); purposes stay separate. */
export function rulesText(doc: RulesDocument): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  push(
    `# ${mdCode(RULES_COMMAND)} — Compiled Policy`,
    "",
    "The represented policy, compiled to English from its Datalog clauses.",
    "",
    `- Policy: version ${mdCode(String(doc.policy.policyVersion))}, \`rulesHash\` ${mdCode(doc.policy.rulesHash)}`,
    `- Sources: ${doc.policy.sources.map(mdCode).join(", ")} (bundled; English model ${mdCode(String(doc.policy.englishModelVersion))})`,
  );
  if (doc.scope.complete) {
    push(`- Scope: ${mdEscape(doc.scope.note)}`);
  } else {
    const filterFlags = Object.entries(doc.scope.filters)
      .map(([k, v]) => `--${k} ${v}`)
      .join(" ");
    push(`- Scope: FILTERED (${mdCode(filterFlags)}). ${mdEscape(doc.scope.note)}`);
  }
  const ep = doc.effectivePolicy;
  if (ep.state === "active") {
    push(
      `- Effective policy: shipped default plus project preferences from ${mdCode(ep.source)} (\`effectiveRulesHash\` ${mdCode(ep.effectiveRulesHash ?? "")}; \`projectRulesHash\` ${mdCode(ep.projectRulesHash ?? "")})`,
    );
  } else if (ep.state === "disabled") {
    push(
      `- Effective policy: the shipped default only (project preferences disabled: ${mdEscape(ep.reason ?? "")})`,
    );
  } else if (ep.state === "error") {
    push(
      `- Effective policy: ERROR. ${mdEscape(ep.reason ?? "")}. The project preferences are enabled but not in force; briefings are incomplete until this is fixed. ${ep.next.map(mdEscape).join("; ")}`,
    );
  } else {
    push(`- Effective policy: unknown. ${mdEscape(ep.reason ?? "")}`);
  }
  push(`- See also: ${mdEscape(doc.related.process)}`);
  push(
    '- Reading: `?t` is the ticket or pull request, `?r` a decision rule; `name(?x)` is a predicate defined in the glossary; `"no match for"` means no fact matches, which is not proof of the opposite.',
  );

  push(
    "",
    "## Defaults",
    "",
    "Bundled defaults (declared by `pdb`, not read from any repository):",
    "",
  );
  for (const d of doc.defaults.declared) {
    push(`- ${mdCode(d.name)} = ${mdCode(JSON.stringify(d.value))} (${mdEscape(d.declaredBy)})`);
  }
  const effective = doc.defaults.effective;
  if (effective.status === "unknown") {
    push("", `This repository's effective settings: unknown. ${mdEscape(effective.reason)}`);
  } else {
    push(
      "",
      `Effective settings of ${mdCode(effective.repository)} (read from ${mdCode(effective.readFrom)} in its verified local checkout):`,
      "",
    );
    for (const s of effective.settings) {
      push(
        `- ${mdCode(s.name)} = ${mdCode(JSON.stringify(s.value))} (${s.source === "explicit" ? "stored in the settings file" : "not stored; the registry default applies"})`,
      );
    }
  }

  const show = (n: number) => doc.scope.complete || n > 0;
  if (show(doc.decisions.length)) {
    push(
      "",
      `## Decision rules (${doc.decisions.length})`,
      "",
      "Each rule proposes its action for every `?t` its conditions match.",
    );
    for (const { band, decisions } of decisionGroups(doc.decisions)) {
      push("", `### Band ${band}`);
      for (const d of decisions) push(...mdDecisionLines(d));
    }
  }

  if (show(doc.eligibility.denials.length)) {
    push("", `## Eligibility and denials (${doc.eligibility.denials.length})`);
    if (doc.eligibility.denialQuery) {
      const q = doc.eligibility.denialQuery;
      push(
        "",
        "### Denials query",
        "",
        `- ${mdEscape(queryHeader(q))}`,
        ...mdClauseLines(q.clauses, "  "),
      );
    }
    for (const d of doc.eligibility.denials) push(...mdDenialLines(d));
  }

  push(
    "",
    "## Ordering",
    "",
    `Sort keys, compared in this sequence, smaller first: ${doc.ordering.comparison.map(mdCode).join(", ")}.`,
  );
  if (doc.ordering.overrides.length) {
    push("", "Declared overrides (winner over loser, when both match the same `?t`):", "");
    for (const o of doc.ordering.overrides) push(`- ${mdCode(o.winner)} over ${mdCode(o.loser)}`);
  }
  for (const q of doc.ordering.overrideQueries) {
    push("", `### Override query: ${mdEscape(queryHeader(q))}`, "", ...mdClauseLines(q.clauses));
  }
  if (doc.ordering.sortQuery) {
    push(
      "",
      `### Sort query: ${mdEscape(queryHeader(doc.ordering.sortQuery))}`,
      "",
      ...mdClauseLines(doc.ordering.sortQuery.clauses),
    );
  }
  for (const q of doc.ordering.keyQueries) {
    push("", `### Sort key query: ${mdEscape(queryHeader(q))}`, "", ...mdClauseLines(q.clauses));
  }

  if (doc.project) {
    const p = doc.project;
    push(
      "",
      `## Project preferences (${p.preferences.length})`,
      "",
      `From ${mdCode(p.source)}. ${p.statements.map(mdEscape).join(" ")}`,
    );
    for (const pref of p.preferences) push(...mdPreferenceLines(pref));
    if (p.helpers.length) {
      push("", "### Project helpers");
      for (const h of p.helpers) {
        push(
          "",
          `- ${mdCode(predicateHead(h.name, h.params))} all of:`,
          ...mdClauseLines(h.clauses, "  "),
        );
      }
    }
    if (p.limits) {
      push(
        "",
        `Limits: at most ${p.limits.actions} adjustable actions and ${p.limits.datoms} projected facts; evaluation within ${p.limits.evaluationMs} ms after a ${p.limits.startupMs} ms worker start. Excess is an error, never a partial ranking.`,
        "",
        "Project inputs (projection lexicon, read-only):",
        "",
        ...Object.entries(p.limits.lexicon.attributes).map(
          ([k, v]) => `- ${mdCode(k)}: ${mdEscape(v)}`,
        ),
      );
    }
  }

  if (doc.queries.length) {
    push("", `## Other engine queries (${doc.queries.length})`);
    for (const q of doc.queries) {
      push("", `### ${mdEscape(queryHeader(q))}`, "", ...mdClauseLines(q.clauses));
    }
  }

  push(
    "",
    `## Predicate glossary (${doc.predicates.length})`,
    "",
    "Each numbered definition is sufficient on its own; within one, every condition must hold.",
  );
  for (const p of doc.predicates) {
    const tag = p.set === "ordering" ? " `[ordering rules]`" : "";
    push("", `### ${mdCode(`${p.name}(${p.params.join(", ")})`)}${tag}`, "");
    p.alternatives.forEach((a, i) => {
      const own =
        a.params.join(", ") === p.params.join(", ")
          ? ""
          : ` ${mdCode(predicateHead(p.name, a.params))}`;
      const childIndent = " ".repeat(`${i + 1}. `.length);
      push(`${i + 1}.${own} all of:`, ...mdClauseLines(a.clauses, childIndent));
    });
    const used = p.usedBy;
    const parts = used
      ? [
          ...used.decisions.map(mdCode),
          ...used.denials.map(mdCode),
          ...used.predicates.map((x) => mdCode(`${x}()`)),
          ...used.queries.map((x) => `query ${mdCode(x)}`),
        ]
      : [];
    push(`- Used by: ${parts.length ? parts.join(", ") : "none"}`);
  }

  if (doc.evidence.length) {
    push("", "## Evidence every rule may show", "");
    for (const line of evidenceLines(doc.evidence, "")) {
      push(`- ${mdEscape(line)}`);
    }
  }

  push("", "## Constant sets", "");
  for (const [name, values] of Object.entries(doc.constants)) {
    push(`- ${mdCode(name)}: ${values.map((v) => mdCode(JSON.stringify(v))).join(", ")}`);
  }

  push("", "## Inputs (lexicon)", "", "### Viewer facts", "");
  for (const [k, v] of Object.entries(doc.lexicon.viewer)) {
    push(`- ${mdCode(k)}: ${mdEscape(v)}`);
  }
  push("", "### Attributes", "");
  for (const [k, v] of Object.entries(doc.lexicon.attributes)) {
    push(`- ${mdCode(k)}: ${mdEscape(v)}`);
  }

  push("", "## Not formalized here", "");
  for (const s of doc.boundary.statements) push(`- ${mdEscape(s)}`);

  const c = doc.coverage;
  push(
    "",
    `Coverage of the full policy: ${c.decisions} decision rules, ${c.denials} denials, ${c.predicates} predicates (${c.alternatives} definitions), ${c.queries} queries, ${c.keyQueries} sort key queries, ${c.evidence} evidence bindings, ${c.overrides} declared overrides, ${c.constants} constant sets, ${c.attributes} attributes, ${c.clauses} clauses.`,
  );
  if (!doc.scope.complete) {
    push("", "This output is a filtered subset; the counts above describe the full policy.");
  }
  return `${out.join("\n")}\n`;
}

/** Legacy plain-text formal listing kept for the web Rules page's `<pre class="rules">` cards. */
export function rulesFormalText(doc: RulesDocument): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  push(
    `${RULES_COMMAND}: the represented policy, compiled to English from its Datalog clauses`,
    `Policy: version ${doc.policy.policyVersion}, rulesHash ${doc.policy.rulesHash}`,
    `Sources: ${doc.policy.sources.join(", ")} (bundled; English model ${doc.policy.englishModelVersion})`,
  );
  if (doc.scope.complete) push(`Scope: ${doc.scope.note}`);
  else
    push(
      `Scope: FILTERED (${Object.entries(doc.scope.filters)
        .map(([k, v]) => `--${k} ${v}`)
        .join(" ")}). ${doc.scope.note}`,
    );
  const ep = doc.effectivePolicy;
  if (ep.state === "active")
    push(
      `Effective policy: shipped default plus project preferences from ${ep.source} (effectiveRulesHash ${ep.effectiveRulesHash}; projectRulesHash ${ep.projectRulesHash})`,
    );
  else if (ep.state === "disabled")
    push(`Effective policy: the shipped default only (project preferences disabled: ${ep.reason})`);
  else if (ep.state === "error")
    push(
      `Effective policy: ERROR. ${ep.reason}. The project preferences are enabled but not in force; briefings are incomplete until this is fixed. ${ep.next.join("; ")}`,
    );
  else push(`Effective policy: unknown. ${ep.reason}`);
  push(`See also: ${doc.related.process}`);
  push(
    'Reading: ?t is the ticket or pull request, ?r a decision rule; name(?x) is a predicate defined in the glossary; "no match for" means no fact matches, which is not proof of the opposite.',
  );

  push("", "== Defaults ==", "Bundled defaults (declared by pdb, not read from any repository):");
  for (const d of doc.defaults.declared)
    push(`  ${d.name} = ${JSON.stringify(d.value)}  (${d.declaredBy})`);
  const effective = doc.defaults.effective;
  if (effective.status === "unknown")
    push(`This repository's effective settings: unknown. ${effective.reason}`);
  else {
    push(
      `Effective settings of ${effective.repository} (read from ${effective.readFrom} in its verified local checkout):`,
    );
    for (const s of effective.settings)
      push(
        `  ${s.name} = ${JSON.stringify(s.value)}  (${s.source === "explicit" ? "stored in the settings file" : "not stored; the registry default applies"})`,
      );
  }

  // A filtered view omits sections its filter emptied; the complete listing shows every section.
  const show = (n: number) => doc.scope.complete || n > 0;
  if (show(doc.decisions.length)) push("", `== Decision rules (${doc.decisions.length}) ==`);
  if (show(doc.decisions.length))
    push("Each rule proposes its action for every ?t its conditions match.");
  for (const { band, decisions } of decisionGroups(doc.decisions)) {
    push("", `Band ${band}`);
    for (const d of decisions) {
      push(...decisionFormalLines(d));
    }
  }

  if (show(doc.eligibility.denials.length))
    push("", `== Eligibility and denials (${doc.eligibility.denials.length}) ==`);
  if (doc.eligibility.denialQuery) push(...denialQueryLines(doc.eligibility.denialQuery));
  for (const d of doc.eligibility.denials) push(...denialFormalLines(d));

  push("", "== Ordering ==");
  push(
    `Sort keys, compared in this sequence, smaller first: ${doc.ordering.comparison.join(", ")}.`,
  );
  if (doc.ordering.overrides.length) {
    push("Declared overrides (winner over loser, when both match the same ?t):");
    for (const o of doc.ordering.overrides) push(`  ${o.winner} over ${o.loser}`);
  }
  for (const q of doc.ordering.overrideQueries)
    push(`Override query ${queryHeader(q)}`, ...clauseLines(q.clauses, "    "));
  if (doc.ordering.sortQuery)
    push(
      `Sort query ${queryHeader(doc.ordering.sortQuery)}`,
      ...clauseLines(doc.ordering.sortQuery.clauses, "    "),
    );
  for (const q of doc.ordering.keyQueries)
    push(`Sort key query ${queryHeader(q)}`, ...clauseLines(q.clauses, "    "));

  if (doc.project) {
    const p = doc.project;
    push("", `== Project preferences (${p.preferences.length}) ==`);
    push(`From ${p.source}. ${p.statements.join(" ")}`);
    for (const pref of p.preferences) {
      push(...preferenceFormalLines(pref));
    }
    if (p.helpers.length) {
      push("Project helpers:");
      for (const h of p.helpers)
        push(`  ${predicateHead(h.name, h.params)} all of:`, ...clauseLines(h.clauses, "      "));
    }
    if (p.limits)
      push(
        `Limits: at most ${p.limits.actions} adjustable actions and ${p.limits.datoms} projected facts; evaluation within ${p.limits.evaluationMs} ms after a ${p.limits.startupMs} ms worker start. Excess is an error, never a partial ranking.`,
        "Project inputs (projection lexicon, read-only):",
        ...Object.entries(p.limits.lexicon.attributes).map(([k, v]) => `  ${k}: ${v}`),
      );
  }

  if (doc.queries.length) {
    push("", `== Other engine queries (${doc.queries.length}) ==`);
    for (const q of doc.queries) push(`  ${queryHeader(q)}`, ...clauseLines(q.clauses, "      "));
  }

  push("", `== Predicate glossary (${doc.predicates.length}) ==`);
  push("Each numbered definition is sufficient on its own; within one, every condition must hold.");
  for (const p of doc.predicates) {
    push(`  ${p.name}(${p.params.join(", ")})${p.set === "ordering" ? " [ordering rules]" : ""}`);
    p.alternatives.forEach((a, i) => {
      // An alternative written over different head variables is shown with its own head.
      const own =
        a.params.join(", ") === p.params.join(", ") ? "" : ` ${predicateHead(p.name, a.params)}`;
      push(`    (${i + 1})${own} all of:`, ...clauseLines(a.clauses, "        "));
    });
    const used = p.usedBy;
    const parts = used
      ? [
          ...used.decisions,
          ...used.denials,
          ...used.predicates.map((x) => `${x}()`),
          ...used.queries.map((x) => `query ${x}`),
        ]
      : [];
    push(`    Used by: ${parts.length ? parts.join(", ") : "none"}`);
  }

  if (doc.evidence.length) {
    push("", "== Evidence every rule may show ==");
    push(...evidenceLines(doc.evidence, "  "));
  }

  push("", "== Constant sets ==");
  for (const [name, values] of Object.entries(doc.constants))
    push(`  ${name}: ${values.map((v) => JSON.stringify(v)).join(", ")}`);

  push("", "== Inputs (lexicon) ==", "Viewer facts:");
  for (const [k, v] of Object.entries(doc.lexicon.viewer)) push(`  ${k}: ${v}`);
  push("Attributes:");
  for (const [k, v] of Object.entries(doc.lexicon.attributes)) push(`  ${k}: ${v}`);

  push("", "== Not formalized here ==");
  for (const s of doc.boundary.statements) push(`  - ${s}`);

  const c = doc.coverage;
  push(
    "",
    `Coverage of the full policy: ${c.decisions} decision rules, ${c.denials} denials, ${c.predicates} predicates (${c.alternatives} definitions), ${c.queries} queries, ${c.keyQueries} sort key queries, ${c.evidence} evidence bindings, ${c.overrides} declared overrides, ${c.constants} constant sets, ${c.attributes} attributes, ${c.clauses} clauses.`,
  );
  if (!doc.scope.complete)
    push("This output is a filtered subset; the counts above describe the full policy.");
  return `${out.join("\n")}\n`;
}

export const rulesHelp = `Usage: pdb rules [--json] [--rule ID] [--role implementer|designer]
Prints the effective policy as readable Markdown in English, compiled from the bundled Datalog
clauses: policy identity, declared defaults, decision rules by band, eligibility and denials,
ordering and declared overrides, the project's native preferences when they are enabled in this
checkout (pdb config set rules.project.enabled true), other engine queries, the predicate
glossary, constants, inputs and what is not formalized here. Local: no GitHub calls or
credentials; it reads only this checkout's configuration and pdb.rules.edn.
  --rule ID     One decision rule, denial or predicate, with the predicates it needs and its
                precedence context (rules of the same kind and declared overrides), or one
                project preference or helper of an active project policy
  --role R      Rules for implementer or designer; rules without a top-level role fact stay
  --json        Versioned document (schemaVersion ${RULES_SCHEMA_VERSION}); the Markdown is the same document
  --help        Show usage
pdb rules init writes a starter pdb.rules.edn bound to the shipped policy into this checkout,
never overwriting a file and enabling nothing.
Filtered output says so and is never the complete policy. pdb process is the short workflow
guide. Exit: 0 printed; 2 invalid arguments or unknown rule; 1 missing or mismatched artifact.
`;
