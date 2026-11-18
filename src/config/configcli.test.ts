import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runConfig, runSetup } from "./configcli.js";
import { createGitService } from "../git/service.js";
import { nodeFileSystem } from "./config.js";

describe("configcli typed GitService (#905)", () => {
  it("runs config get and setup identity with an injected GitService", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-configcli-"));
    try {
      await writeFile(
        join(dir, "pdb.toml"),
        `schema_version = 2\nrepository = "o/r"\n\n[agents.antigravity]\ntriage_role = "implementer"\nname = "alice"\n`,
      );
      const gitService = createGitService({
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${dir}\n`;
          if (args[0] === "remote" && args[1] === "-v")
            return "origin\thttps://github.com/o/r.git (fetch)\n";
          if (args[0] === "rev-parse" && args[1] === "--git-path")
            return `${dir}/.git/${args[2]}\n`;
          if (args[0] === "check-ignore")
            throw Object.assign(new Error("not ignored"), { code: 1 });
          if (args[0] === "ls-files") throw Object.assign(new Error("not tracked"), { code: 1 });
          throw new Error(`Unexpected git args: ${args.join(" ")}`);
        },
      });

      const out: string[] = [];
      const code = await runConfig(
        ["get", "identity.name", "--entry", "antigravity", "--json"],
        async (text) => {
          out.push(text);
        },
        { cwd: dir, fs: nodeFileSystem, gitService },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join("")).value).toBe("alice");

      const setupOut: string[] = [];
      const setupCode = await runSetup(
        ["identity", "--role", "implementer", "--entry", "antigravity", "--dry-run", "--json"],
        async (text) => {
          setupOut.push(text);
        },
        { cwd: dir, fs: nodeFileSystem, gitService },
      );
      expect(setupCode).toBe(0);
      expect(JSON.parse(setupOut.join("")).name).toBe("alice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
