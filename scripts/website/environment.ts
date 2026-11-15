import { CaptureFailure } from "./failure.js";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunProcess } from "./process.js";

export async function isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = resolve(root, "home");
  await mkdir(home, { mode: 0o700, recursive: true });
  // This is an allowlist, deliberately not {...process.env} followed by a few deletions.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, "config"),
    XDG_CACHE_HOME: resolve(home, "cache"),
    GH_CONFIG_DIR: resolve(home, "gh"),
    npm_config_userconfig: resolve(home, "npmrc"),
    npm_config_globalconfig: resolve(home, "global-npmrc"),
    npm_config_cache: resolve(home, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: resolve(home, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    PDB_NO_UPDATE_CHECK: "1",
    PDB_NO_FIRST_USE_HINT: "1",
    PDB_NO_CHECKOUT_CHECK: "1",
    CI: "true",
    LANG: "C.UTF-8",
    TMPDIR: root,
  };
  for (const name of ["SystemRoot", "WINDIR", "PATHEXT"])
    if (process.env[name]) env[name] = process.env[name];
  await writeFile(env.npm_config_userconfig!, "", { mode: 0o600 });
  await writeFile(env.npm_config_globalconfig!, "", { mode: 0o600 });
  return env;
}

export async function createGhTransport(options: {
  root: string;
  source: string;
  realGh: string;
  token: string;
  initialRequests: number;
  env: NodeJS.ProcessEnv;
  run: RunProcess;
}): Promise<{ env: NodeJS.ProcessEnv; budgetPath: string }> {
  if (process.platform === "win32")
    throw new CaptureFailure(
      "Live website capture requires a POSIX host; pure tests support Windows.",
    );
  const compiled = resolve(options.root, "transport");
  const result = await options.run({
    file: process.execPath,
    argv: [
      resolve(options.source, "node_modules/typescript/bin/tsc"),
      "--project",
      resolve(options.source, "scripts/website/transport-tsconfig.json"),
      "--outDir",
      compiled,
    ],
    cwd: options.source,
    env: options.env,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new CaptureFailure("Capture transport compilation failed.");
  await writeFile(resolve(compiled, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
  const shimDir = resolve(options.root, "bin");
  await mkdir(shimDir, { mode: 0o700 });
  const shim = resolve(shimDir, "gh");
  await writeFile(
    shim,
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve(compiled, "gh-proxy.js")).href)});\n`,
    { mode: 0o700 },
  );
  await chmod(shim, 0o700);
  const budgetPath = resolve(options.root, "gh-budget.json");
  // The live deadline starts immediately before the first live command, not during npm install.
  await writeFile(
    budgetPath,
    JSON.stringify({
      schemaVersion: 1,
      requests: options.initialRequests,
      deadline: Date.now() + 120_000,
      maximum: 50,
      refused: false,
    }),
    { mode: 0o600 },
  );
  return {
    budgetPath,
    env: {
      ...options.env,
      PATH: `${shimDir}:${options.env.PATH ?? ""}`,
      GH_TOKEN: options.token,
      PDB_SITE_BUDGET: budgetPath,
      PDB_SITE_REAL_GH: options.realGh,
    },
  };
}
