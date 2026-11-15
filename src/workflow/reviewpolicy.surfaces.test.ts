/**
 * The declared review policy reaches every live read surface (#301, #557 review): CLI pr/who/
 * ticket/team boundaries, the focused who read, team and who delivery, and pdb serve (API and MCP
 * share projectReaders): a --project's own config, or explicitly undeclared with --repo only.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { Snapshot } from "../github/types.js";
import type { DeclaredReviewPolicy } from "./reviewpolicy.js";

const seen: (DeclaredReviewPolicy | undefined)[] = [];
vi.mock("./deliveryread.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./deliveryread.js")>();
  return {
    ...real,
    deliveryRead: (snapshot: Snapshot, ...rest: [never]) => {
      seen.push(snapshot.reviewPolicy);
      return real.deliveryRead(snapshot, ...rest);
    },
  };
});
const { readTeam, readWho, readWhoWith } = await import("./readservices.js");
const { ReadMeter } = await import("../github/readplan.js");
const { noLocalProject, projectReaders, servedReviewPolicy } = await import("../serve/api.js");
const { snapshot } = await import("../testing/snapshots.js");
const { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } =
  await import("../../scripts/benchmark-isolation.js");

const or: DeclaredReviewPolicy = { state: "declared", policy: "codex-or-coderabbit" };
const options = { staleHours: 48, now: new Date("2026-11-15T00:00:00Z"), offline: true };

describe("delivery reads apply the boundaries' declared policy", () => {
  it("team and who", async () => {
    seen.length = 0;
    await readTeam(snapshot(), options, { reviewPolicy: or });
    await readWho(snapshot(), 1, options, { reviewPolicy: or });
    expect(seen).toEqual([or, or]);
  });
  it("the focused live who read attaches it to the snapshot it returns", async () => {
    const focused = snapshot();
    const read = await readWhoWith(
      new ReadMeter("issue-detail-v1", "who"),
      focused.repository,
      1,
      options,
      { reviewPolicy: or },
      (async () => {
        throw new Error("no query");
      }) as never,
      (async () => focused) as never,
    );
    expect(read.snapshot.reviewPolicy).toEqual(or);
  });
});

describe("pdb serve resolves the policy per served repository, never from a directory", () => {
  it("--repo only is explicitly undeclared", async () => {
    expect(await servedReviewPolicy(noLocalProject("o/r"), "o/r")).toEqual({
      state: "undeclared",
      scope: "no-matching-project",
    });
  });
  it("--project reads that project's own configuration", async () => {
    const runtime = {
      projectRuntime: () => {
        const readers = {
          cwd: SYNTHETIC_ROOT,
          git: fakeGit("o/r"),
          fs: {
            ...emptyFileSystem,
            readText: async (path: string) =>
              path.endsWith("triage.toml")
                ? 'schemaVersion = 1\n[review]\npolicy = "codex-or-coderabbit"\n'
                : null,
          },
        };
        return { estimation: readers, guide: readers };
      },
    };
    const readers = projectReaders(runtime as never, "/some/project", "o/r");
    expect(await servedReviewPolicy(readers, "o/r")).toEqual(or);
  });
});

describe("CLI pr N resolves the checkout's declared policy", () => {
  it("reports it in the pr-status JSON", async () => {
    const { main } = await import("../cli.js");
    const head = "a".repeat(40);
    let out = "";
    const pr = {
      number: 12,
      title: "Fix",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: head,
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: "2026-11-15T00:00:00Z",
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: false } } },
            },
          },
        ],
      },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    await main(["pr", "12", "--json", "--repo", "o/r"], async (t) => void (out += t), {
      currentRepository: async () => "o/r",
      query: (async () => ({ repository: { pullRequest: pr } })) as never,
      guide: {
        cwd: SYNTHETIC_ROOT,
        git: fakeGit("o/r"),
        fs: {
          ...emptyFileSystem,
          readText: async (path: string) =>
            path.endsWith("triage.toml")
              ? 'schemaVersion = 1\n[review]\npolicy = "codex-or-coderabbit"\n'
              : null,
        },
      },
    } as never);
    expect(JSON.parse(out).reviewPolicy.declared).toEqual(or);
  });
});
