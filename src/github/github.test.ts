import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { dependencyDone } from "../briefing/briefing.js";
import {
  collect,
  declaredDependencies,
  ghQueryWith,
  graphqlAnswer,
  pages,
  type IssueDiagnosis,
  type Query,
} from "./github.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";
import { brief } from "../testing/briefing.js";

describe("paginated facts and explicit dependency scope", () => {
  it("walks all cursors and rejects repeating cursors", async () => {
    const cursors: (string | undefined)[] = [];
    expect(
      await pages(async (cursor) => {
        cursors.push(cursor);
        return cursor ? page([2]) : page([1], true, "next");
      }),
    ).toEqual([1, 2]);
    expect(cursors).toEqual([undefined, "next"]);
    await expect(pages(async () => page([1], true, "same"))).rejects.toThrow("did not advance");
  });
  it("distinguishes declared, incidental and cross-repository references", () => {
    const refs = declaredDependencies(
      "Epic #99 and evidence #77.\nDepends on #2 and https://github.com/other/repo/pull/3.\n## Dependencies\n- #5\n## Notes\n- #6",
      repo,
    );
    expect(refs.map((ref) => `${ref.repository}#${ref.number}`)).toEqual([
      "other/repo#3",
      `${repo}#2`,
      `${repo}#5`,
    ]);
  });
  it("accepts an explicit declaration after a sentence and ignores subsequent prose links", () => {
    expect(
      declaredDependencies(
        "Owner asks for work. **Depends on:** #2. See #99 for an unrelated example.",
        repo,
      ).map((ref) => ref.number),
    ).toEqual([2]);
  });
  it("never equates a closed unplanned issue or unknown reference with completed work", () => {
    const ref = { repository: repo, number: 2, url: "url", available: true, state: "CLOSED" };
    expect(dependencyDone({ ...ref, stateReason: "NOT_PLANNED" })).toBe(false);
    expect(dependencyDone(ref)).toBe(false);
    expect(dependencyDone({ ...ref, stateReason: "COMPLETED" })).toBe(true);
    expect(dependencyDone({ ...ref, state: "MERGED" })).toBe(true);
  });
  it("collects primary pages, all comment pages, a closed prerequisite and since changes", async () => {
    const first = issue();
    first.body = "Depends on #8.";
    first.issueDependenciesSummary!.totalBlockedBy = 1;
    first.blockedBy = page([
      {
        ...issue(8),
        state: "CLOSED",
        stateReason: "COMPLETED",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    first.comments = page(
      [{ body: "A question?", url: "comment1", author: null }],
      true,
      "comments2",
    );
    const calls: string[] = [];
    const query: Query = async (source, vars) => {
      calls.push(source);
      if (source.includes("issueOrPullRequest(number") && source.includes("comments(first"))
        return {
          repository: {
            issueOrPullRequest: {
              comments: page([{ body: "Answered", url: "comment2", author: { login: "owner" } }]),
            },
          },
        };
      if (source.includes("issueOrPullRequest(number"))
        return {
          repository: {
            issueOrPullRequest: {
              title: "Completed",
              state: "CLOSED",
              stateReason: "COMPLETED",
              url: "dependency",
            },
          },
        };
      if (source.includes("pullRequests(first")) return { repository: { pullRequests: page([]) } };
      if (source.includes("states:OPEN"))
        return {
          repository: { issues: vars.cursor ? page([issue(2)]) : page([first], true, "issues2") },
        };
      return { repository: { issues: page([{ ...issue(9), state: "CLOSED" }]) } };
    };
    const data = await collect(repo, { since: time }, query, () => new Date(time));
    expect(data.issues).toHaveLength(2);
    expect(data.issues[0]!.comments.nodes.map((comment) => comment.body)).toEqual([
      "A question?",
      "Answered",
    ]);
    expect(data.dependencies[0]?.stateReason).toBe("COMPLETED");
    expect(data.changed[0]?.state).toBe("CLOSED");
    expect(calls.some((source) => source.includes("after:$cursor"))).toBe(true);
  });
  it("reports incomplete nested PR evidence rather than claiming merge readiness", async () => {
    const pull = pr();
    pull.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "next" };
    const data = await collect(
      repo,
      {},
      async (source) => ({
        repository: {
          issues: page([]),
          pullRequests: page(source.includes("pullRequests(first") ? [pull] : []),
        },
      }),
      () => new Date(time),
    );
    expect(data.warnings[0]).toContain("review threads");
    expect(brief(data).actions.items.some((item) => item.rule === "pr-inspect-merge")).toBe(false);
  });
});

describe("intake evidence boundaries", () => {
  it("flags ready work with unresolved native prerequisites without claiming it", () => {
    const one = issue();
    one.body = "Depends on #8.";
    const data = snapshot([one], []);
    one.issueDependenciesSummary!.blockedBy = 1;
    one.issueDependenciesSummary!.totalBlockedBy = 1;
    one.blockedBy = page([
      {
        ...issue(8),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    const finding = brief(data).actions.items.find(
      (item) => item.rule === "ready-prerequisites-unverified",
    );
    expect(finding?.uncertainty).toBe("candidate");
    expect(finding?.evidence).toContain(`https://github.com/${repo}/issues/8`);
  });
  it("does not label an arbitrary issue link as architectural evidence", () => {
    const one = issue();
    one.body = "See https://github.com/example/project/issues/9 and doc/game-architecture.md.";
    const data = brief(snapshot([one], []));
    expect(data.ready.items[0]?.documentation).toEqual(["doc/game-architecture.md"]);
  });
  it("does not propose merge when mergeability is unknown", () => {
    const pull = pr();
    pull.mergeable = "UNKNOWN";
    expect(
      brief(snapshot([], [pull])).actions.items.some((item) => item.rule === "pr-inspect-merge"),
    ).toBe(false);
  });
});

describe("plain JavaScript gh wrapper", () => {
  it.skipIf(process.platform === "win32")(
    "terminates the running gh child process when a read is aborted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-gh-abort-"));
      const path = process.env.PATH;
      try {
        const pidFile = join(dir, "pid");
        // The fake gh records its pid, then replaces itself with a long sleep.
        await writeFile(join(dir, "gh"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, {
          mode: 0o700,
        });
        process.env.PATH = `${dir}:${path}`;
        const controller = new AbortController();
        const pending = ghQueryWith(controller.signal)("query{viewer{login}}", {}).then(
          () => "resolved",
          (error: unknown) => error,
        );
        let pid = 0;
        for (let i = 0; i < 200 && !pid; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
        }
        expect(pid).toBeGreaterThan(0);
        controller.abort();
        expect(await pending).toMatchObject({ name: "AbortError" });
        let alive = true;
        for (let i = 0; i < 200 && alive; i++) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
        // An already aborted signal never starts gh at all.
        await rm(pidFile);
        await expect(ghQueryWith(controller.signal)("query{viewer{login}}", {})).rejects.toThrow();
        await expect(readFile(pidFile, "utf8")).rejects.toThrow();
      } finally {
        process.env.PATH = path;
        await rm(dir, { recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs directly with Node and reuses the inherited gh session without login",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-gh-test-"));
      try {
        const log = join(dir, "calls");
        const response = JSON.stringify({
          data: { repository: { issues: page([]), pullRequests: page([]) } },
        });
        const fake = `#!/bin/sh
[ "$TRIAGE_TEST_SESSION" = "already-configured" ] || exit 98
echo "$1" >> "$TRIAGE_TEST_LOG"
case "$1" in
repo) printf '%s\\n' 'example/project' ;;
api) printf '%s\\n' '${response}' ;;
*) exit 99 ;;
esac
`;
        await writeFile(join(dir, "gh"), fake, { mode: 0o700 });
        const { stdout } = await promisify(execFile)(
          process.execPath,
          // Source development runs through tsx (doc/design/typescript.md).
          ["--import", "tsx", fileURLToPath(new URL("../cli.ts", import.meta.url)), "--json"],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              TRIAGE_TEST_SESSION: "already-configured",
              TRIAGE_TEST_LOG: log,
            },
          },
        );
        expect(JSON.parse(stdout).repository).toBe(repo);
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["repo", "api", "api"]);
        for (const name of ["cli", "github/github", "briefing/briefing"]) {
          const code = await readFile(new URL(`../${name}.ts`, import.meta.url), "utf8");
          expect(code).not.toMatch(/(?:from|import)\s+["'][^"']+\.ts["']/);
        }
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  );
});

describe("gh GraphQL variables (#312 review)", () => {
  it.skipIf(process.platform === "win32")(
    "sends strings raw with -f, so numeric, boolean or @-prefixed values stay literal; numbers use -F",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-gh-args-"));
      const path = process.env.PATH;
      try {
        const log = join(dir, "args");
        await writeFile(
          join(dir, "gh"),
          `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf '%s\\n' '{"data":{"repository":null}}'\n`,
          { mode: 0o700 },
        );
        process.env.PATH = `${dir}:${path}`;
        await ghQueryWith()("query{viewer{login}}", {
          l0: "123",
          l1: "true",
          l2: "@etc/passwd",
          n: 5,
        });
        const args = (await readFile(log, "utf8")).trim().split("\n");
        const flagOf = (value: string) => args[args.indexOf(value) - 1];
        expect(flagOf("l0=123")).toBe("-f");
        expect(flagOf("l1=true")).toBe("-f");
        expect(flagOf("l2=@etc/passwd")).toBe("-f");
        expect(flagOf("n=5")).toBe("-F");
      } finally {
        process.env.PATH = path;
        await rm(dir, { recursive: true });
      }
    },
  );
});

describe("GraphQL NOT_FOUND answers", () => {
  it("treats NOT_FOUND-only errors as a valid null answer and anything else as failure", () => {
    const missing = JSON.stringify({
      data: { repository: { issueOrPullRequest: null } },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
    });
    expect(graphqlAnswer(missing)).toEqual({ repository: { issueOrPullRequest: null } });
    const forbidden = JSON.stringify({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND" }, { type: "FORBIDDEN" }],
    });
    expect(graphqlAnswer(forbidden)).toBeNull();
    expect(graphqlAnswer(JSON.stringify({ data: {}, errors: [] }))).toBeNull();
    expect(graphqlAnswer("not json")).toBeNull();
    expect(graphqlAnswer(undefined)).toBeNull();
  });
});

describe("transferred issue inspection (#39, doc/design/diagnostics.md)", () => {
  const rest = (status: number | null, body: any) => async () => ({ status, body });
  it("distinguishes moved, pull request, missing, forbidden and unknown", async () => {
    const { locateIssue } = await import("./github.js");
    const moved = await locateIssue(
      "o/old",
      701,
      rest(200, {
        repository_url: "https://api.github.com/repos/o/new",
        number: 2,
        html_url: "https://github.com/o/new/issues/2",
      }),
    );
    expect(moved).toMatchObject({
      state: "moved",
      url: "https://github.com/o/old/issues/701",
      destination: { repository: "o/new", number: 2, url: "https://github.com/o/new/issues/2" },
    });
    const same = { repository_url: "https://api.github.com/repos/o/old", number: 5 };
    expect((await locateIssue("o/old", 5, rest(200, { ...same, pull_request: {} }))).state).toBe(
      "pull-request",
    );
    expect((await locateIssue("o/old", 5, rest(404, { status: "404" }))).state).toBe("missing");
    expect((await locateIssue("o/old", 5, rest(403, { status: "403" }))).state).toBe("forbidden");
    expect((await locateIssue("o/old", 5, rest(null, null))).state).toBe("unknown");
    // Missing or forbidden never claims a transfer.
    expect("destination" in (await locateIssue("o/old", 5, rest(404, {})))).toBe(false);
  });
  it("reports instead of failing, and follows a transfer only with --include-transferred", async () => {
    const { IssueUnavailable } = await import("./github.js");
    const diagnosis = {
      repository: "o/old",
      number: 701,
      url: "https://github.com/o/old/issues/701",
      state: "moved" as const,
      destination: { repository: "o/new", number: 2, url: "https://github.com/o/new/issues/2" },
      detail: "Transferred.",
      next: "x",
    };
    const seen: string[] = [];
    const runtime = {
      currentRepository: async () => "o/old",
      collect: async (repository: string, options: { issue?: number }) => {
        seen.push(`${repository}#${options.issue}`);
        if (repository === "o/old") throw new IssueUnavailable(diagnosis);
        return snapshot([issue(2)], []);
      },
    } as any;
    let out = "";
    const write = async (x: string) => void (out = x);
    expect(await main(["--repo", "o/old", "--issue", "701", "--json"], write, runtime)).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ kind: "issue-unavailable", state: "moved" });
    expect(seen).toEqual(["o/old#701"]);
    const code = await main(
      ["--repo", "o/old", "--issue", "701", "--json", "--include-transferred"],
      write,
      runtime,
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["o/old#701", "o/old#701", "o/new#2"]);
    expect(JSON.parse(out).transferredFrom).toMatchObject({ url: diagnosis.url });
  });
});

describe("transferred issue inspection when GraphQL fails (#39)", () => {
  it("diagnoses a failed read through REST, keeping the error when REST is not authoritative", async () => {
    const { collect } = await import("./github.js");
    const failing: Query = async () => {
      throw new Error("GitHub query failed.");
    };
    const forbidden = async (): Promise<IssueDiagnosis> => ({
      repository: "o/x",
      number: 3,
      url: "u",
      state: "forbidden",
      detail: "denied",
      next: "gh auth status",
    });
    await expect(collect("o/x", { issue: 3, locate: forbidden }, failing)).rejects.toMatchObject({
      diagnosis: { state: "forbidden" },
    });
    const unknown = async (): Promise<IssueDiagnosis> => ({
      repository: "o/x",
      number: 3,
      url: "u",
      state: "unknown",
      detail: "",
      next: "",
    });
    await expect(collect("o/x", { issue: 3, locate: unknown }, failing)).rejects.toThrow(
      "GitHub query failed.",
    );
    // Without --issue the original failure is unchanged.
    await expect(collect("o/x", {}, failing)).rejects.toThrow("GitHub query failed.");
  });
});
