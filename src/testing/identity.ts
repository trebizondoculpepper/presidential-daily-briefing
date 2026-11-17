/** Disposable identity store with injected local Git and allocation boundaries. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBinding } from "../config/activebinding.js";
import { nodeFileSystem, type GitRunner } from "../config/config.js";
import { IDENTITY_FILE, setIdentity } from "../config/identity.js";

export async function withIdentityFixture<T>(
  run: (f: Awaited<ReturnType<typeof createIdentityFixture>>) => Promise<T>,
): Promise<T> {
  const f = await createIdentityFixture();
  try {
    return await run(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}

export async function createIdentityFixture() {
  const root = await mkdtemp(join(tmpdir(), "pdb-binding-"));
  const repository = "example/project";
  const file = join(root, IDENTITY_FILE);
  const excluded = join(root, ".git", "info", "exclude");
  const fs = nodeFileSystem;
  const git: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
    if (args[0] === "rev-parse" && args[1] === "--git-path") return `${excluded}\n`;
    if (args[0] === "remote") return `origin\thttps://github.com/${repository}.git (fetch)\n`;
    if (args[0] === "ls-files") throw Object.assign(new Error("untracked"), { code: 1 });
    if (args[0] === "check-ignore") {
      const name = args.at(-1)!;
      const rule = name.endsWith(".tmp") ? "/pdb.toml.*.tmp" : `/${name}`;
      if (((await fs.readText(excluded)) ?? "").split(/\r?\n/).includes(rule)) return "";
      throw Object.assign(new Error("not ignored"), { code: 1 });
    }
    throw new Error(`Unexpected Git operation ${args[0]}`);
  };
  let seed = 0;
  const random = () => ((seed++ % 97) + 0.5) / 97;
  const binding = (thread: string) =>
    activeBinding({
      root,
      repository,
      env: { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: thread },
    })!;
  const setup = (thread: string, role: "implementer" | "designer" = "implementer") => {
    const b = binding(thread);
    return setIdentity({ root, repository }, b.entry, "identity.triage_role", role, {
      fs,
      git,
      random,
      requireName: true,
      reuseExistingIdentity: true,
      binding: { key: b.key, expectedEntry: null, newSessionHarness: b.harness },
    });
  };
  return { root, repository, file, excluded, fs, git, random, binding, setup };
}

export type IdentityFixture = Awaited<ReturnType<typeof createIdentityFixture>>;
