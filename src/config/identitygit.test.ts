import { describe, expect, it } from "vite-plus/test";
import { identityGitState, resolveIdentityTarget } from "./identity.js";
import { createGitService } from "../git/service.js";
import type { GitService } from "../git/service.js";

// Synthetic typed answers only; no repository is read.
const service = (over: Partial<GitService>): GitService => ({
  ...createGitService({ git: async () => "" }),
  ...over,
});

describe("identity Git reads through the typed Git service (#910)", () => {
  it("resolves the identity target from an injected shared service", async () => {
    const git = service({
      workingTreeRoot: async () => "/w",
      remotes: async () => [
        { name: "origin", url: "u", host: "github.com", repository: "owner/repo" },
      ],
    });
    expect(await resolveIdentityTarget("/w/sub", "Owner/Repo", git)).toEqual({
      root: "/w",
      repository: "owner/repo",
    });
    await expect(resolveIdentityTarget("/w", "a/b", git)).rejects.toMatchObject({
      code: "repository-mismatch",
    });
  });

  it("reports tracked and ignored state, and unknown when Git cannot answer", async () => {
    expect(
      await identityGitState(
        "/w",
        service({ isTracked: async () => false, isIgnored: async () => true }),
      ),
    ).toEqual({ tracked: false, ignored: true });
    expect(
      await identityGitState(
        "/w",
        service({
          isTracked: async () => {
            throw new Error("boom");
          },
          isIgnored: async () => false,
        }),
      ),
    ).toEqual({ tracked: null, ignored: false });
  });
});
