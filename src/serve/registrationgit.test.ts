import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { createGitService } from "../git/service.js";
import type { GitService } from "../git/service.js";
import { GLOBAL_CONFIG_FILE } from "../config/globalconfig.js";
import type { GlobalConfigFileSystem } from "../config/globalconfig.js";
import { resolveServeProjects } from "./registration.js";

// Synthetic typed answers and an in-memory configuration only; nothing reaches Git or GitHub.
describe("serve registration through the typed Git service (#937)", () => {
  const dir = "/global";
  const files = new Map<string, string>();
  const fs: GlobalConfigFileSystem = {
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, text) => void files.set(path, text),
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (path) => void files.delete(path),
    makeDirectory: async () => undefined,
  };

  it("resolves the working checkout from an injected shared GitService's root and remotes", async () => {
    let resolverCalls = 0;
    const shared: GitService = {
      ...createGitService({ git: async () => "" }),
      workingTreeRoot: async ({ cwd }) =>
        cwd.startsWith("/work/project") ? "/work/project" : null,
      remotes: async () => [
        { name: "origin", url: "u", host: "github.com", repository: "owner/project" },
      ],
    };
    const result = await resolveServeProjects(
      { repos: [], projects: [] },
      {
        cwd: "/work/project/sub",
        git: shared,
        currentRepository: async () => {
          resolverCalls++;
          return "";
        },
        globalConfig: { dir, fs },
      },
    );
    expect(result.served).toEqual([{ repository: "owner/project", project: "/work/project" }]);
    // One GitHub remote is authoritative: the gh resolver is never consulted.
    expect(resolverCalls).toBe(0);
    expect(files.get(join(dir, GLOBAL_CONFIG_FILE))).toContain('repository = "owner/project"');
  });
});
