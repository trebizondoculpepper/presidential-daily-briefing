import { describe, expect, it } from "vite-plus/test";
import { resolveRepositoryTarget } from "./config.js";
import type { GitRunner } from "./config.js";

// Synthetic git answers only; no repository is read.
const fake =
  (root: string | Error, remotes: string | Error): GitRunner =>
  async (args) => {
    const answer = args[0] === "rev-parse" ? root : remotes;
    if (answer instanceof Error) throw answer;
    return answer;
  };

describe("resolveRepositoryTarget over the typed Git service (#904)", () => {
  it("verifies the checkout from its parsed GitHub remotes, deduplicated", async () => {
    const git = fake(
      "/w/repo\n",
      "origin\tgit@github.com:Owner/Repo.git (fetch)\norigin\thttps://github.com/owner/repo (push)\nmirror\thttps://gitlab.com/x/y (fetch)\n",
    );
    expect(await resolveRepositoryTarget("/w/repo/sub", undefined, git)).toEqual({
      root: "/w/repo",
      repository: "owner/repo",
    });
    expect(await resolveRepositoryTarget("/w/repo", "OWNER/repo", git)).toMatchObject({
      repository: "owner/repo",
    });
  });

  it("refuses a directory outside a checkout and a mismatched repository", async () => {
    await expect(
      resolveRepositoryTarget(
        "/tmp",
        undefined,
        fake(new Error("fatal: not a git repository"), ""),
      ),
    ).rejects.toMatchObject({ code: "not-a-repository" });
    await expect(
      resolveRepositoryTarget(
        "/w",
        "a/b",
        fake("/w\n", "origin\thttps://github.com/c/d (fetch)\n"),
      ),
    ).rejects.toMatchObject({ code: "repository-mismatch" });
  });

  it("treats unreadable remotes as none rather than guessing", async () => {
    await expect(
      resolveRepositoryTarget("/w", undefined, fake("/w\n", new Error("boom"))),
    ).rejects.toMatchObject({ code: "repository-mismatch" });
  });
});
