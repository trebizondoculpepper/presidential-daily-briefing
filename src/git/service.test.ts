import { describe, expect, it } from "vite-plus/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitRunner } from "../config/config.js";
import { createGitService, GitError, remoteHost, sanitizedGitEnvironment } from "./service.js";

/**
 * Typed Git service (#897, doc/design/github-service-composition.md). A focused fake proves the
 * interpretation and error classification; one disposable real checkout proves the same
 * operations against the installed Git executable. Nothing here writes to the repository.
 */
describe("typed Git service (#897)", () => {
  /** A fake transport: each argv is answered from a table, and unlisted calls fail like Git. */
  function fakeGit(answers: Record<string, string>, fail?: Record<string, Error>) {
    const calls: string[][] = [];
    const git: GitRunner = async (args, _cwd) => {
      calls.push([...args]);
      const key = args.join(" ");
      const failure = fail?.[key];
      if (failure) throw failure;
      const answer = answers[key];
      if (answer === undefined) {
        throw Object.assign(new Error("exit 1"), { code: 1, stderr: "" });
      }
      return answer;
    };
    return { git, calls };
  }

  it("returns typed checkout facts and interprets the output itself", async () => {
    const { git, calls } = fakeGit({
      "rev-parse --show-toplevel": "/work/project\n",
      "rev-parse --git-common-dir": "/work/project/.git\n",
      "rev-parse --git-path info/exclude": "/work/project/.git/info/exclude\n",
      "remote -v":
        "origin\tgit@github.com:owner/project.git (fetch)\norigin\tgit@github.com:owner/project.git (push)\n",
      "rev-parse --verify -q HEAD": "abc1234\n",
      "symbolic-ref -q HEAD": "refs/heads/main\n",
    });
    const service = createGitService({ git });
    const context = { cwd: "/work/project/sub" };
    expect(await service.workingTreeRoot(context)).toBe("/work/project");
    expect(await service.commonDirectory(context)).toBe("/work/project/.git");
    expect(await service.gitPath(context, "info/exclude")).toBe("/work/project/.git/info/exclude");
    expect(await service.remotes(context)).toEqual([
      {
        name: "origin",
        url: "git@github.com:owner/project.git",
        host: "github.com",
        repository: "owner/project",
      },
    ]);
    expect(await service.checkout(context)).toEqual({
      host: "github.com",
      repository: "owner/project",
    });
    expect(await service.revision(context)).toBe("abc1234");
    expect(await service.headRef(context)).toBe("refs/heads/main");
    // The service owns argv; callers never see it.
    expect(calls).toContainEqual(["rev-parse", "--show-toplevel"]);
  });

  it("answers absence with null instead of a failure", async () => {
    const { git } = fakeGit(
      {},
      {
        "rev-parse --verify -q HEAD": Object.assign(new Error("exit 1"), {
          code: 1,
          stderr: "fatal: Needed a single revision",
        }),
        "symbolic-ref -q HEAD": Object.assign(new Error("exit 1"), { code: 1, stderr: "" }),
      },
    );
    const service = createGitService({ git });
    const context = { cwd: "/work/unborn" };
    expect(await service.revision(context)).toBeNull();
    expect(await service.headRef(context)).toBeNull();
  });

  it("distinguishes a missing checkout, cancellation and a real failure", async () => {
    const missing = createGitService({
      git: async () => {
        throw Object.assign(new Error("exit 128"), {
          code: 128,
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        });
      },
    });
    expect(await missing.workingTreeRoot({ cwd: "/nowhere" })).toBeNull();
    await expect(missing.remotes({ cwd: "/nowhere" })).resolves.toEqual([]);

    const cancelled = createGitService({
      git: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    await expect(cancelled.workingTreeRoot({ cwd: "/work" })).rejects.toMatchObject({
      code: "cancelled",
    });

    const broken = createGitService({
      git: async () => {
        throw new Error("spawn git ENOENT");
      },
    });
    await expect(broken.workingTreeRoot({ cwd: "/work" })).rejects.toBeInstanceOf(GitError);
    await expect(broken.workingTreeRoot({ cwd: "/work" })).rejects.toMatchObject({
      code: "failed",
    });
  });

  it("keeps a remote's distinct fetch and push URLs, and refuses the ambiguity", async () => {
    const { git } = fakeGit({
      "remote -v":
        "origin\thttps://github.com/owner/a.git (fetch)\norigin\thttps://github.com/other/b.git (push)\n",
    });
    const service = createGitService({ git });
    const remotes = await service.remotes({ cwd: "/work" });
    expect(remotes.map((remote) => remote.repository)).toEqual(["owner/a", "other/b"]);
    // Fetching one repository and pushing to another is a real Git configuration, and it is
    // not a verified identity.
    expect(await service.checkout({ cwd: "/work" })).toBeNull();
  });

  it("accepts a partial-clone filter annotation after the fetch entry (#897)", async () => {
    const { git } = fakeGit({
      "remote -v":
        "origin\thttps://github.com/owner/a.git (fetch) [blob:none]\norigin\thttps://github.com/other/b.git (push)\n",
    });
    const service = createGitService({ git });
    const remotes = await service.remotes({ cwd: "/work" });
    expect(remotes.map((remote) => remote.repository)).toEqual(["owner/a", "other/b"]);
    // A filtered fetch remote that pushes elsewhere is not a verified identity.
    expect(await service.checkout({ cwd: "/work" })).toBeNull();
  });

  it("refuses to name a checkout whose remotes disagree", async () => {
    const { git } = fakeGit({
      "remote -v":
        "origin\thttps://github.com/owner/a.git (fetch)\nupstream\thttps://github.com/other/b.git (fetch)\n",
    });
    expect(await createGitService({ git }).checkout({ cwd: "/work" })).toBeNull();
  });

  it("reports divergence and ancestry from Git's own answers", async () => {
    const { git } = fakeGit(
      { "rev-list --left-right --count main...feature": "2\t3\n" },
      {
        "merge-base --is-ancestor main feature": Object.assign(new Error("exit 1"), { code: 1 }),
      },
    );
    const service = createGitService({ git });
    const context = { cwd: "/work" };
    expect(await service.divergence(context, "main", "feature")).toEqual({ left: 2, right: 3 });
    expect(await service.isAncestor(context, "main", "feature")).toBe(false);
  });

  it("answers ignore and tracked checks, treating Git's exit 1 as a fact", async () => {
    const { git } = fakeGit(
      {
        "check-ignore --quiet -- .env": "",
        "--literal-pathspecs ls-files --error-unmatch -- tracked.txt": "tracked.txt\n",
      },
      {
        "check-ignore --quiet -- tracked.txt": Object.assign(new Error("exit 1"), { code: 1 }),
        "--literal-pathspecs ls-files --error-unmatch -- other.txt": Object.assign(
          new Error("exit 1"),
          { code: 1 },
        ),
      },
    );
    const service = createGitService({ git });
    const context = { cwd: "/work" };
    expect(await service.isIgnored(context, ".env")).toBe(true);
    expect(await service.isIgnored(context, "tracked.txt")).toBe(false);
    expect(await service.isTracked(context, "tracked.txt")).toBe(true);
    expect(await service.isTracked(context, "other.txt")).toBe(false);
  });

  it("keeps trailing spaces in a returned path and answers unknown revisions as absence", async () => {
    const { git } = fakeGit(
      {
        "rev-parse --show-toplevel": "/tmp/project \n",
        "rev-parse --git-path info/exclude": "/tmp/project /.git/info/exclude\n",
      },
      {
        "merge-base --is-ancestor missing HEAD": Object.assign(new Error("exit 128"), {
          code: 128,
          stderr: "fatal: Not a valid object name missing",
        }),
      },
    );
    const service = createGitService({ git });
    const context = { cwd: "/tmp/project" };
    // A real directory may end in a space; trimming would name a different path.
    expect(await service.workingTreeRoot(context)).toBe("/tmp/project ");
    expect(await service.gitPath(context, "info/exclude")).toBe("/tmp/project /.git/info/exclude");
    expect(await service.isAncestor(context, "missing", "HEAD")).toBe(false);
  });

  it("keeps spaces inside a remote URL and answers a bare repository as absence", async () => {
    const { git } = fakeGit(
      {
        "remote -v": "origin\t/file path/with space/repo.git (fetch)\n",
      },
      {
        "rev-parse --show-toplevel": Object.assign(new Error("exit 128"), {
          code: 128,
          stderr: "fatal: this operation must be run in a work tree",
        }),
      },
    );
    const service = createGitService({ git });
    expect(await service.remotes({ cwd: "/work" })).toEqual([
      { name: "origin", url: "/file path/with space/repo.git", host: null, repository: null },
    ]);
    // A bare repository has no working tree: absence, not a failure.
    expect(await service.workingTreeRoot({ cwd: "/work" })).toBeNull();
  });

  it("parses the hosts of the remote URL forms Git accepts", () => {
    expect(remoteHost("git@github.com:owner/name.git")).toBe("github.com");
    expect(remoteHost("https://github.com/owner/name.git")).toBe("github.com");
    expect(remoteHost("ssh://git@ghe.example.com:2222/o/n.git")).toBe("ghe.example.com");
    expect(remoteHost("C:\\work")).toBeNull();
    expect(remoteHost("/local/path")).toBeNull();
  });

  // One disposable checkout: the same operations against the installed Git executable.
  it("reads a real disposable checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-git-service-"));
    // Sanitized like the service's own transport: a parent GIT_DIR must not redirect these.
    const env = sanitizedGitEnvironment();
    const run = (file: string, args: readonly string[], options: { cwd: string }) =>
      promisify(execFile)(file, [...args], { ...options, env });
    const git = async (args: readonly string[], cwd: string) =>
      (await run("git", args, { cwd })).stdout;
    try {
      await run("git", ["init", "-q"], { cwd: root });
      await run("git", ["remote", "add", "origin", "https://github.com/owner/real.git"], {
        cwd: root,
      });
      await writeFile(join(root, "tracked.txt"), "hello\n");
      await run("git", ["add", "tracked.txt"], { cwd: root });
      await run("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "first"], {
        cwd: root,
      });
      const service = createGitService({ git });
      const context = { cwd: root };
      const { realpath } = await import("node:fs/promises");
      // Git reports forward slashes on Windows; realpath normalises both spellings.
      const reported = await service.workingTreeRoot(context);
      expect(await realpath(reported!)).toBe(await realpath(root));
      expect(await service.checkout(context)).toEqual({
        host: "github.com",
        repository: "owner/real",
      });
      expect(await service.revision(context)).toMatch(/^[0-9a-f]{40}$/);
      expect(await service.headRef(context)).toMatch(/^refs\/heads\//);
      expect(await service.isTracked(context, "tracked.txt")).toBe(true);
      expect(await service.isTracked(context, "untracked.txt")).toBe(false);
      await expect(service.isIgnored(context, "tracked.txt")).resolves.toBe(false);
      expect(await service.isAncestor(context, "HEAD", "HEAD")).toBe(true);
      // A commit id that was never fetched is an absent revision, not a failure.
      expect(
        await service.divergence(context, "1111111111111111111111111111111111111111", "HEAD"),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
