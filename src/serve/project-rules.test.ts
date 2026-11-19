/**
 * Native project preferences in `pdb serve` (#516 part 3): each served project's own setting and
 * policy file, read per request, isolated between projects and clients; a changed file is never
 * served from an older generation; `--repo` only is the explicit `unavailable` state. Synthetic
 * checkouts in temporary directories; no GitHub.
 */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import type { Issue, Page } from "../github/types.js";
import { compileProjectPolicy } from "../rules/datalog/project/compile.js";
import { policyVersion, rulesHash } from "../rules/datalog/engine.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";

const base = { policyVersion, rulesHash };
const fixture = readFileSync(
  new URL("../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
).replace(/:base-rules-hash "[0-9a-f]{64}"/, `:base-rules-hash "${rulesHash}"`);
const withPriority = (n: number) => fixture.replace("[(+ 0 10) ?value]", `[(+ 0 ${n}) ?value]`);

const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (repo: string, n: number, labels: string[]): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: `https://github.com/${repo}/issues/${n}`,
  state: "OPEN",
  stateReason: null,
  createdAt: `2026-11-0${n}T00:00:00Z`,
  updatedAt: "2026-11-12T09:00:00.000Z",
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page(),
  blocking: page(),
  labels: page(labels.map((name) => ({ name }))),
  comments: page(),
});
const queryFor =
  (repo: string): Query =>
  async (source) => ({
    repository: {
      issues: page(
        source.includes("issues(first")
          ? [
              issue(repo, 1, ["status:ready", "impact:L", "complexity:S"]),
              issue(repo, 2, ["status:ready", "impact:L", "complexity:S"]),
              issue(repo, 3, ["status:ready", "impact:L", "complexity:S", "project:priority"]),
            ]
          : [],
      ),
      pullRequests: page([]),
      issue: null,
    },
  });
const clock = {
  now: () => new Date("2026-11-12T10:00:00.000Z"),
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};

interface Checkout {
  dir: string;
  repository: string;
  enabled: boolean;
}
async function setup(checkouts: Checkout[], extra: string[] = []) {
  const byDir = new Map(checkouts.map((c) => [c.dir, c]));
  const gitAt =
    (c: Checkout): GitRunner =>
    async (args) =>
      args[0] === "rev-parse"
        ? `${c.dir}\n`
        : `origin\thttps://github.com/${c.repository}.git (fetch)\n`;
  const fsFor = (c: Checkout): ConfigFileSystem => ({
    readText: async (path) =>
      path.endsWith("triage.toml")
        ? `schemaVersion = 1\n[rules.project]\nenabled = ${c.enabled}\n`
        : null,
    writeText: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  });
  const serve: ServeRuntime = {
    currentRepository: async (project?: string) => byDir.get(project!)!.repository,
    authContext: async () => ({ host: "github.com", login: "octo" }),
    clock,
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
    // The rules page reads the checkout it is given; route by that directory.
    rulesPage: {
      git: async (args, cwd) => gitAt(byDir.get(cwd!) ?? checkouts[0]!)(args, cwd),
      fs: {
        ...fsFor(checkouts[0]!),
        readText: async (path) => {
          const c = checkouts.find((x) => path.startsWith(x.dir));
          return c ? fsFor(c).readText(path) : null;
        },
      },
    },
  };
  const read: ServeReadRuntime = {
    collectIssueFocus: async () => {
      throw new Error("unused");
    },
    collect: (repository, options) => collect(repository, options, queryFor(repository), clock.now),
    dependencyReport: async () => {
      throw new Error("unused");
    },
    now: clock.now,
    env: {},
    git: gitAt(checkouts[0]!),
    fs: fsFor(checkouts[0]!),
    projectRuntime: (project) => {
      const c = byDir.get(project ?? "")!;
      return {
        estimation: { fs: fsFor(c), git: gitAt(c), cwd: c.dir },
        guide: { fs: fsFor(c), git: gitAt(c), cwd: c.dir },
      };
    },
  };
  const options = serveArguments([
    "--port",
    "0",
    ...checkouts.flatMap((c) => ["--project", c.dir]),
    ...extra,
  ]);
  return startServe(options, serve, readServices(options, serve, read));
}
const get = (port: number, path: string): Promise<any> =>
  new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            done(JSON.parse(body));
          } catch {
            done(body);
          }
        });
      },
    );
    req.on("error", fail);
    req.end();
  });
const briefing = (port: number, repo: string) =>
  get(port, `/api/v1/briefing?repo=${encodeURIComponent(repo)}&role=implementer&agent=me`);
const first = (env: any) =>
  Number(
    env.result.rankedActions.items
      .find((a: any) => a.kind === "implement")
      .target.split("/")
      .pop(),
  );

describe("project preferences in pdb serve (#516)", () => {
  it("isolates projects, never serves an older generation, and names the revision everywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-516-serve-"));
    const a = { dir: join(root, "a"), repository: "example/a", enabled: true };
    const b = { dir: join(root, "b"), repository: "example/b", enabled: false };
    try {
      for (const c of [a, b]) {
        await import("node:fs/promises").then((fs) => fs.mkdir(c.dir));
        await writeFile(join(c.dir, "pdb.rules.edn"), fixture);
      }
      const running = await setup([a, b], ["--repo", "example/remote"]);
      try {
        const policy = compileProjectPolicy(fixture, base);
        // Concurrent reads of both projects: each gets only its own policy.
        const [ra, rb, rr] = await Promise.all([
          briefing(running.port, a.repository),
          briefing(running.port, b.repository),
          briefing(running.port, "example/remote"),
        ]);
        expect(ra.result.decisionEngine.effectivePolicy).toMatchObject({
          state: "active",
          effectiveRulesHash: policy.effectiveRulesHash,
        });
        expect(ra.result.decisionEngine.rulesHash).toBe(policy.effectiveRulesHash);
        expect(first(ra)).toBe(3);
        expect(rb.result.decisionEngine.effectivePolicy).toMatchObject({ state: "disabled" });
        expect(rb.result.decisionEngine.rulesHash).toBe(rulesHash);
        expect(first(rb)).toBe(1);
        // --repo only: explicit and named, the default order, and the briefing stays complete.
        expect(rr.result.decisionEngine.effectivePolicy).toMatchObject({
          state: "unavailable",
          effectiveRulesHash: null,
          reason: expect.stringContaining("--project"),
        });
        expect(rr.status).toBe(rb.status);

        // A changed file is read on the next request: never the earlier cached generation.
        await writeFile(join(a.dir, "pdb.rules.edn"), withPriority(20));
        const changed = await briefing(running.port, a.repository);
        const next = compileProjectPolicy(withPriority(20), base);
        expect(next.effectiveRulesHash).not.toBe(policy.effectiveRulesHash);
        expect(changed.result.decisionEngine.rulesHash).toBe(next.effectiveRulesHash);
        expect(changed.freshness.source).toBe("cached"); // the GitHub facts, not the policy

        // A broken file is an explicit error at once, never the previous active policy.
        await writeFile(join(a.dir, "pdb.rules.edn"), "{:format-version 1");
        const broken = await briefing(running.port, a.repository);
        expect(broken.status).toBe("incomplete");
        expect(broken.result.decisionEngine.effectivePolicy).toMatchObject({
          state: "error",
          effectiveRulesHash: null,
        });
        await writeFile(join(a.dir, "pdb.rules.edn"), withPriority(20));

        // The rules page and diagnostics name the same revision and source.
        // #853: the rules page reads /api/v1/rules, which carries the effective policy.
        const pageA = await get(
          running.port,
          `/api/v1/rules?repo=${encodeURIComponent(a.repository)}`,
        );
        expect(pageA.view.effectivePolicy.effectiveRulesHash).toBe(next.effectiveRulesHash);
        const pageRemote = await get(running.port, "/api/v1/rules?repo=example%2Fremote");
        expect(pageRemote.view.effectivePolicy.state).toBe("unknown");
        const diag = await get(running.port, "/api/v1/diagnostics/rules?repo=example%2Fremote");
        expect(diag.data.projectPolicy.state).toBe("unknown");
        const diagA = await get(
          running.port,
          `/api/v1/diagnostics/rules?repo=${encodeURIComponent(a.repository)}`,
        );
        expect(diagA.data.projectPolicy.state).toBe("per-request");
      } finally {
        await running.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
