/**
 * Immutable input projection for native project preferences (#515,
 * doc/design/native-project-rules.md, "Immutable input projection and admission").
 *
 * The shipped default policy runs first. This module turns its already-admitted, ordered actions
 * into the closed, read-only action vocabulary project rules may read, in a separate database.
 * Protected bands are never projected, so a project rule cannot see, reorder or annotate them.
 * Nothing here evaluates a project query; the worker does that, and admission.ts validates it.
 */
import type { Datom, Schema } from "datascript";

/** Addressed attention (1) and concrete PR follow-up (2) keep their default position and reasons. */
export const protectedBands: ReadonlySet<number> = new Set([1, 2]);
/** Contract v1 input limits; excess is an explicit error, never silent truncation. */
export const projectionLimits = { actions: 500, datoms: 50_000 } as const;
/**
 * The projection database schema; grammar.ts's projectionVocabulary declares the same one for the
 * compiler. Kept here so the evaluator chunk does not import the build-time EDN reader.
 */
export const projectionSchema: Schema = {
  "pdb.action-label": { ":db/cardinality": ":db.cardinality/many" },
};
/** Entity 1 holds viewer facts; action entities begin here with per-evaluation opaque IDs. */
export const firstActionEntity = 100;

export class ProjectEvaluationError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(
      `project policy ${code}: ${detail}. The project policy was not applied; ` +
        "repair pdb.rules.edn or disable the project policy",
    );
  }
}

type Metric = { state: string; size: string | null };
/** The fields of a default-admitted action (RankedAction/DatalogAction) the projection reads. */
export interface AdmittedAction {
  id: string;
  kind: string;
  role: string;
  target: string;
  band: number;
  impact: Metric;
  complexity: Metric;
  unlocks: number;
  unlocksUnknown: readonly string[];
}
/** Collected subject facts for an action's target; absent targets project no labels or head. */
export interface ProjectionSubject {
  labels: readonly string[];
  labelsComplete: boolean;
  /** Current PR head when the target is a pull request and it is known. */
  head?: string | null;
}
export interface ProjectionViewer {
  role: string;
  order: string;
}
export interface Projection {
  /** A copy of the default input order; never mutated. */
  readonly actions: readonly AdmittedAction[];
  readonly datoms: readonly Datom[];
  readonly schema: Schema;
  /** Opaque entity → exact action identity, for adjustable actions only. */
  readonly identities: ReadonlyMap<number, string>;
  /** Exact action identity → index into `actions`. */
  readonly positions: ReadonlyMap<string, number>;
}

/**
 * Exact admitted identity: repository + subject + action kind (the default action ID) + role.
 * Never the subject alone, so a project result cannot rename one admitted kind as another.
 */
export const actionIdentity = (a: Pick<AdmittedAction, "id" | "role">): string =>
  `${a.id} ${a.role}`;

/** Build the read-only project database for the adjustable default actions, in default order. */
export function projectActions(
  actions: readonly AdmittedAction[],
  subjects: ReadonlyMap<string, ProjectionSubject>,
  viewer: ProjectionViewer,
): Projection {
  const copy = actions.map((a) => ({ ...a }));
  const positions = new Map<string, number>();
  for (const [i, a] of copy.entries()) {
    const key = actionIdentity(a);
    if (positions.has(key))
      throw new ProjectEvaluationError("invalid-projection", `duplicate admitted action ${key}`);
    positions.set(key, i);
  }
  const adjustable = copy.filter((a) => !protectedBands.has(a.band));
  if (adjustable.length > projectionLimits.actions)
    throw new ProjectEvaluationError(
      "project-scope-exceeded",
      `at most ${projectionLimits.actions} adjustable actions are supported`,
    );
  const datoms: Datom[] = [
    [1, "role", viewer.role],
    [1, "order", viewer.order],
  ];
  const put = (e: number, attribute: string, value: string | number | boolean) => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new ProjectEvaluationError("invalid-projection", `${attribute} is not an integer`);
    if (datoms.length >= projectionLimits.datoms)
      throw new ProjectEvaluationError(
        "project-scope-exceeded",
        `at most ${projectionLimits.datoms} projected datoms are supported`,
      );
    datoms.push([e, attribute, value]);
  };
  const identities = new Map<number, string>();
  for (const [i, a] of adjustable.entries()) {
    const e = firstActionEntity + i,
      subject = subjects.get(a.target);
    identities.set(e, actionIdentity(a));
    put(e, "pdb.action-id", actionIdentity(a));
    put(e, "pdb.action-kind", a.kind);
    put(e, "pdb.action-role", a.role);
    put(e, "pdb.action-target", a.target);
    put(e, "pdb.base-band", a.band);
    put(e, "pdb.impact-state", a.impact.state);
    put(e, "pdb.complexity-state", a.complexity.state);
    // A size is only a fact when its assessment is current; otherwise it stays absent.
    if (a.impact.state === "current" && a.impact.size) put(e, "pdb.impact-size", a.impact.size);
    if (a.complexity.state === "current" && a.complexity.size)
      put(e, "pdb.complexity-size", a.complexity.size);
    // A proven lower bound; coverage says whether it is complete. Absence never means zero.
    put(e, "pdb.unlocks", a.unlocks);
    put(e, "pdb.unlocks-complete", a.unlocksUnknown.length === 0);
    if (subject) {
      // Completeness is inherited from the default admission, never reasserted by the project.
      put(e, "pdb.labels-complete", subject.labelsComplete);
      for (const label of new Set(subject.labels)) put(e, "pdb.action-label", label);
      if (subject.head) put(e, "pdb.head", subject.head);
    }
  }
  return {
    actions: copy,
    datoms,
    schema: projectionSchema,
    identities,
    positions,
  };
}

/** Labels, label completeness and PR head per collected subject URL, for `projectActions`. */
export function projectionSubjects(snapshot: {
  issues: readonly { url: string; labels: SubjectLabels }[];
  pullRequests: readonly { url: string; labels: SubjectLabels; headRefOid?: string | null }[];
}): Map<string, ProjectionSubject> {
  const subjects = new Map<string, ProjectionSubject>();
  for (const s of [...snapshot.issues, ...snapshot.pullRequests])
    subjects.set(s.url, {
      labels: s.labels.nodes.map((l) => l.name),
      labelsComplete: !s.labels.pageInfo.hasNextPage,
      head: "headRefOid" in s && typeof s.headRefOid === "string" ? s.headRefOid : null,
    });
  return subjects;
}
type SubjectLabels = { nodes: readonly { name: string }[]; pageInfo: { hasNextPage: boolean } };
