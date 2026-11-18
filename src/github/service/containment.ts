/**
 * Commit containment reads for the typed GH service (#943, #890): a repository's live default
 * branch, a commit's identity in a repository, and the compare API's containment of a commit in
 * a target branch head. Every answer is validated; anything inconclusive is unknown (null or
 * `state: "unknown"`), never contained or absent.
 */
import type { Rest } from "../github.js";

/** The caller's GraphQL executor (structurally the workflow's `GraphQuery`). */
type GraphQuery = (query: string, variables: Record<string, string | number>) => Promise<unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** A repository's live default branch, or null when it cannot be read. */
export async function defaultBranch(repository: string, query: GraphQuery): Promise<string | null> {
  const [owner, name] = repository.split("/");
  try {
    const data = await query(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}`,
      { owner: owner ?? "", name: name ?? "" },
    );
    const repo = isRecord(data) ? data.repository : null;
    const ref = isRecord(repo) ? repo.defaultBranchRef : null;
    return isRecord(ref) && str(ref.name) && ref.name ? ref.name : null;
  } catch {
    return null;
  }
}

/** A commit's identity in a repository, or null when it is not a readable commit there. */
export async function commitOf(
  query: GraphQuery,
  repository: string,
  oid: string,
): Promise<{ repository: string; oid: string } | null> {
  const [owner, name] = repository.split("/");
  try {
    const data = await query(
      `query($owner:String!,$name:String!,$oid:String!){repository(owner:$owner,name:$name){nameWithOwner object(expression:$oid){__typename ... on Commit{oid}}}}`,
      { owner: owner ?? "", name: name ?? "", oid },
    );
    const repo = isRecord(data) ? data.repository : null;
    const object = isRecord(repo) ? repo.object : null;
    return isRecord(repo) &&
      str(repo.nameWithOwner) &&
      isRecord(object) &&
      object.__typename === "Commit" &&
      str(object.oid) &&
      /^[0-9a-f]{40,64}$/.test(object.oid)
      ? { repository: repo.nameWithOwner, oid: object.oid }
      : null;
  } catch {
    return null;
  }
}

/** One live containment compare of a commit against a target branch head. */
export interface Containment {
  /** `contained` and `absent` are positive evidence; anything inconclusive is `unknown`. */
  state: "contained" | "absent" | "unknown";
  /** The branch compared against (the live default branch when the target names none). */
  branch: string | null;
  /** The compare API's status, when one was returned. */
  status: string | null;
  why: string;
}

/**
 * Live containment of a commit in the target branch head (the compare API, base = the branch,
 * head = the commit): `identical` or `behind` is contained, `ahead` or `diverged` is positively
 * absent, and an error, a missing or unreadable branch or an unexpected status is unknown. The
 * default branch is read live unless `branchOf` supplies this read's own live answer; a branch
 * recorded or cached elsewhere is never substituted.
 */
export async function targetContainment(
  target: { repository: string; branch: string | null },
  oid: string,
  rt: { query: GraphQuery; rest: Rest },
  branchOf: (repository: string) => Promise<string | null> = (r) => defaultBranch(r, rt.query),
): Promise<Containment> {
  const branch = target.branch ?? (await branchOf(target.repository));
  if (!branch)
    return {
      state: "unknown",
      branch: null,
      status: null,
      why: `the default branch of ${target.repository} could not be read`,
    };
  try {
    const answer = await rt.rest(
      `repos/${target.repository}/compare/${encodeURIComponent(branch)}...${oid}`,
    );
    const status =
      answer.status === 200 && typeof answer.body === "object" && answer.body !== null
        ? (answer.body as { status?: unknown }).status
        : undefined;
    const text = typeof status === "string" ? status : null;
    if (status === "identical" || status === "behind")
      return { state: "contained", branch, status: text, why: `contained in ${branch}` };
    if (status === "ahead" || status === "diverged")
      return { state: "absent", branch, status: text, why: `not contained in ${branch} (${text})` };
    return {
      state: "unknown",
      branch,
      status: text,
      why: `the compare against ${target.repository}:${branch} was inconclusive (${answer.status === 200 ? `status ${text ?? "missing"}` : `HTTP ${answer.status ?? "error"}`})`,
    };
  } catch (error) {
    return {
      state: "unknown",
      branch,
      status: null,
      why: `the compare against ${target.repository}:${branch} failed (${error instanceof Error ? error.message : "unknown error"})`,
    };
  }
}

/** The containment reads as one capability object over one query and REST executor. */
export interface ContainmentReads {
  defaultBranch(repository: string): Promise<string | null>;
  commit(repository: string, oid: string): Promise<{ repository: string; oid: string } | null>;
  targetContainment(
    target: { repository: string; branch: string | null },
    oid: string,
    branchOf?: (repository: string) => Promise<string | null>,
  ): Promise<Containment>;
}

/** Containment reads over one executor pair (the facade's own, or a read's metered ones). */
export function containmentReads(query: GraphQuery, rest: Rest): ContainmentReads {
  return {
    defaultBranch: (repository) => defaultBranch(repository, query),
    commit: (repository, oid) => commitOf(query, repository, oid),
    targetContainment: (target, oid, branchOf) =>
      targetContainment(target, oid, { query, rest }, branchOf),
  };
}
