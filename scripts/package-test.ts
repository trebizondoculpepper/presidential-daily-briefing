#!/usr/bin/env node
// All ordinary child processes are credential-free; fatal checks explicitly override this.
process.env.SENTRY_DISABLED = "1";
/**
 * Installed-archive test (doc/npm-releases.md, "Verification and publication").
 *
 * Packs the real npm archive, checks its contents against the allowlist, installs that exact
 * archive globally into an isolated temporary npm prefix (the recommended installation, #17),
 * and runs the installed `pdb` executable through npm's bin link from separate
 * working directories: help, invalid arguments, and the credential-free offline smoke checks.
 * Direct source or dist execution alone is not enough (#11).
 */
import { defaultCrashDsn } from "../src/telemetry/crashes.js";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveEngineSetting, defaultEngine } from "../src/config/engine-setting.js";
import { parityDifference } from "../src/mcp/parity.js";
import { crashMessage } from "../src/telemetry/crashes.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const run = promisify(execFile);
const windows = process.platform === "win32";
const npm = (args: string[], cwd: string) =>
  run(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows });
const root = resolve(".");
const expected = [
  "LICENSE",
  "README.md",
  "dist/cli.mjs",
  "dist/cli.mjs.map",
  "dist/mcp.mjs",
  "dist/mcp.mjs.map",
  "package.json",
  "third-party/README.md",
  "third-party/datascript-LICENSE",
  "third-party/legacy-project-MIT-LICENSE",
];

interface PackResult {
  filename: string;
  name: string;
  files: { path: string }[];
}

/** Validate `npm pack --json` output instead of trusting its shape. */
function parsePack(stdout: string): PackResult {
  const parsed: unknown = JSON.parse(stdout);
  // npm <= 11 prints an array of results; npm 12 prints an object keyed by package name.
  const first: unknown = Array.isArray(parsed)
    ? parsed[0]
    : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed)[0]
      : undefined;
  if (
    typeof first === "object" &&
    first !== null &&
    "filename" in first &&
    typeof first.filename === "string" &&
    "name" in first &&
    typeof first.name === "string" &&
    "files" in first &&
    Array.isArray(first.files)
  ) {
    const files = first.files.map((f: unknown) => {
      if (typeof f === "object" && f !== null && "path" in f && typeof f.path === "string")
        return { path: f.path };
      throw new Error("npm pack reported a file without a path.");
    });
    return { filename: first.filename, name: first.name, files };
  }
  throw new Error("npm pack --json returned an unexpected result.");
}

/**
 * A credential-free stand-in for `gh` (#260): answers every GraphQL read with one fixed
 * repository state, so the installed CLI and MCP server collect identical facts.
 */
const fakeGh = `#!/usr/bin/env node
const time = "2026-11-12T10:00:00.000Z";
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const issue = (number, labels, createdAt) => ({
  number, title: "Ticket " + number, body: "", url: "https://github.com/example/parity/issues/" + number,
  state: "OPEN", stateReason: null, createdAt, updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]), blocking: page([]), labels: page(labels.map((name) => ({ name }))), comments: page([]),
});
const args = process.argv.slice(2);
// pdb serve reads the login once at startup (doc/design/serve.md); no token is involved.
if (args[0] === "api" && args[1] === "user") { process.stdout.write(JSON.stringify({ login: "package-test" })); process.exit(0); }
// #516: only when asked, pdb serve --project resolves the checkout's repository to this fixture.
if (process.env.PDB_FAKE_REPO_VIEW && args[0] === "repo" && args[1] === "view") { process.stdout.write("example/parity\\n"); process.exit(0); }
// pdb quotas (#547): one REST GET /rate_limit with --include; synthetic counts, no token.
if (args[0] === "api" && args[1] === "--include" && args[2] === "rate_limit") {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify({ resources: { core: { limit: 5000, used: 10, remaining: 4990, reset }, graphql: { limit: 5000, used: 4900, remaining: 100, reset }, search: { limit: 30, used: 0, remaining: 30, reset } } }));
  process.exit(0);
}
if (args[0] !== "api" || args[1] !== "graphql") { process.stderr.write("unsupported"); process.exit(1); }
const query = (args.find((a) => a.startsWith("query=")) || "");
const all = [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XL"], "2026-11-02T00:00:00Z"),
  issue(3, ["status:needs-design", "complexity:XS"], "2026-11-03T00:00:00Z"),
  issue(4, ["status:ready", "impact:S", "complexity:M"], "2026-10-01T00:00:00Z"),
];
// The routine briefing's shortlist hydration (#368): aliased issue(number:$nK) reads.
if (query.includes("i0:issue(")) {
  const repository = {};
  for (const a of args) {
    const m = /^n([0-9]+)=([0-9]+)$/.exec(a);
    if (m) repository["i" + m[1]] = all.find((x) => x.number === Number(m[2])) || null;
  }
  process.stdout.write(JSON.stringify({ data: { repository } }));
  process.exit(0);
}
const issues = query.includes("issues(first") ? [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XL"], "2026-11-02T00:00:00Z"),
  issue(3, ["status:needs-design", "complexity:XS"], "2026-11-03T00:00:00Z"),
  issue(4, ["status:ready", "impact:S", "complexity:M"], "2026-10-01T00:00:00Z"),
] : [];
process.stdout.write(JSON.stringify({ data: { repository: { issues: page(issues), pullRequests: page([]) } } }));
`;

/** Feed a native event to the installed artifact without a shell or development loader. */
async function nativeStopSmoke(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv = {
    ...process.env,
    PDB_NO_EFFECTIVE_IDENTITY: "1",
    PDB_NO_HUMAN_CONTEXT: "1",
    PDB_NO_UPDATE_CHECK: "1",
    PDB_NO_FIRST_USE_HINT: "1",
  },
  withFakeGh = false,
): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), "pdb native $() & "));
  const selection = [
    "--state-dir",
    state,
    "--repo",
    "example/parity",
    "--agent",
    "probe",
    "--role",
    "implementer",
  ];
  const invoke = (args: string[], input: string | null) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "rebrief", ...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (value: string) => {
        text += value;
      });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(text) : reject(new Error("Native package invocation failed")),
      );
      if (input !== null) child.stdin.end(input);
      child.stdin.on("error", () => {});
    });
  try {
    const initialized = JSON.parse(
      await invoke(
        ["init", ...selection, "--json", "--session", "synthetic", "--platform", "codex"],
        "",
      ),
    ) as { reason: string };
    if (initialized.reason !== "initialized")
      throw new Error(`Packaged native init failed (${initialized.reason})`);
    const args = ["codex-stop", ...selection, "--natural-stop-confirmed"];
    const event = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "synthetic",
      turn_id: "t",
      stop_hook_active: false,
      transcript_path: "NEVER_READ $() & path",
    });
    for (const [extra, raw] of [
      [["--transport", "http-mcp"], event.replace('"turn_id":"t"', '"turn_id":"http-gap"')],
      [[], "{"],
      [["--agent", "literal $() & probe"], event],
      [["--deadline-ms", "10"], null],
    ] as const) {
      if ((await invoke([...args, ...extra], raw)) !== "{}\n")
        throw new Error("Packaged native framing/failure mismatch");
    }
    // Run the successful read only when the caller supplied the credential-free fake gh.
    if (withFakeGh) {
      const response = JSON.parse(await invoke(args, event)) as {
        decision?: string;
        reason?: string;
      };
      if (response.decision !== "block" || !response.reason?.includes("example/parity"))
        throw new Error("Packaged native offer missing");
      if ((await invoke(args, event)) !== "{}\n")
        throw new Error("Packaged native duplicate replay");
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

/**
 * Packaged `pdb serve` smoke (doc/design/serve.md, test 9): the installed bin starts on an
 * ephemeral port, prints the stable "listening on URL" line first, answers /healthz and
 * /api/v1/status, and exits 0 after SIGTERM within the shutdown window. POSIX only: Windows
 * cannot deliver a catchable SIGTERM from another process (see pdb serve --help).
 */
async function serveSmoke(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  // Isolation (#805): resolution also reads saved registrations and the checkout, so the smoke
  // server gets a disposable working directory and its own configuration directory. Without
  // this, a caller's real registration or checkout would add repositories to the served set.
  const isolated = { ...env, PDB_CONFIG_DIR: join(cwd, "serve-config") };
  const child = spawn(bin, ["serve", "--repo", "example/parity", "--port", "0"], {
    cwd,
    env: isolated,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes("\n")) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`pdb serve printed no banner. stderr: ${stderr}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    const first = stdout.split("\n")[0]!;
    const url = /listening on (http:\/\/127\.0\.0\.1:\d+\/)$/.exec(first)?.[1];
    if (!url) throw new Error(`Unexpected first banner line: ${first}`);
    const health = await fetch(`${url}healthz`);
    if (health.status !== 200 || JSON.stringify(await health.json()) !== '{"ok":true}')
      throw new Error("Installed pdb serve /healthz did not answer ok.");
    const status = (await (await fetch(`${url}api/v1/status`)).json()) as {
      kind?: string;
      auth?: { login?: string };
    };
    if (status.kind !== "serve-status" || status.auth?.login !== "package-test")
      throw new Error(`Installed pdb serve status is wrong: ${JSON.stringify(status)}`);
    // Read-only diagnostics (#459) answer on an empty installed server without collecting.
    for (const view of ["projects", "config", "cache", "inflight", "errors", "rules"]) {
      const diag = (await (await fetch(`${url}api/v1/diagnostics/${view}`)).json()) as {
        kind?: string;
        data?: { total?: number };
      };
      if (diag.kind !== "serve-diagnostics")
        throw new Error(
          `Installed diagnostics ${view} answered ${JSON.stringify(diag).slice(0, 200)}`,
        );
      if (["cache", "inflight", "errors"].includes(view) && diag.data?.total !== 0)
        throw new Error(`Installed diagnostics ${view} is not empty before any read.`);
    }
    // The project rules page (#392) from the packaged artifact, with no source tree: the same
    // compiled policy as pdb rules, settings unknown for a --repo-only project, only shared navigation script.
    const rulesPage = await fetch(`${url}rules?repo=example%2Fparity`);
    const rulesHtml = await rulesPage.text();
    if (
      rulesPage.status !== 200 ||
      !rulesHtml.includes("<h1>Project rules</h1>") ||
      !/Coverage of the full policy: \d+ decision rules/.test(rulesHtml) ||
      !rulesHtml.includes("effective settings: unknown") ||
      rulesHtml
        .replace('<script src="/project-selection.js" defer></script>', "")
        .includes("<script")
    )
      throw new Error(`Installed pdb serve /rules is wrong: ${rulesHtml.slice(0, 400)}`);
    const navigationScript = await fetch(`${url}project-selection.js`);
    if (
      navigationScript.status !== 200 ||
      !(await navigationScript.text()).includes("pdb.selected-project")
    )
      throw new Error("Installed shared project-selection script is unavailable.");
    // Every shipped HTML page uses the shared toolbar; browser scripts are never executed here.
    for (const path of [
      "?repo=example%2Fparity",
      "ticket?repo=example%2Fparity&n=1",
      "human?repo=example%2Fparity",
      "setup",
      "rules",
      "quotas",
      "diagnostics?repo=example%2Fparity&tab=ticket-doctor",
    ]) {
      const response = await fetch(`${url}${path}`);
      const html = await response.text();
      if (
        response.status !== 200 ||
        !html.includes('class="shell-toolbar"') ||
        !html.includes('href="#content"')
      )
        throw new Error(`Installed shared shell missing on ${path}`);
    }
    // Diagnostics UI and explicit runs must work from the installed artifact, with no source tree.
    const diagnosticsScript = await fetch(`${url}diagnostics.js`);
    if (
      diagnosticsScript.status !== 200 ||
      !(await diagnosticsScript.text()).includes("diagnostic-runs")
    )
      throw new Error("Installed diagnostics client is missing.");
    for (const kind of ["doctor", "ticket-doctor"] as const) {
      const query = `kind=${kind}&repo=example%2Fparity`;
      const latest = await (await fetch(`${url}api/v1/diagnostic-runs/latest?${query}`)).json();
      if (JSON.stringify(latest) !== '{"state":"none"}')
        throw new Error(`Opening the installed diagnostics page started ${kind}.`);
      const started = await fetch(`${url}api/v1/diagnostic-runs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(url).origin },
        body: JSON.stringify({ kind, repo: "example/parity" }),
      });
      const handle = (await started.json()) as { waiterId?: string };
      if (started.status !== 202 || !handle.waiterId)
        throw new Error(`Installed ${kind} did not create a waiter: ${JSON.stringify(handle)}`);
      const runDeadline = Date.now() + 20_000;
      for (;;) {
        const response = await fetch(`${url}api/v1/diagnostic-runs/waiters/${handle.waiterId}`);
        const run = (await response.json()) as {
          state?: string;
          result?: { scope?: string; checks?: unknown[]; kind?: string };
        };
        if (run.state !== "running") {
          if (!["completed", "partial"].includes(run.state ?? "") || !run.result)
            throw new Error(`Installed ${kind} failed: ${JSON.stringify(run).slice(0, 600)}`);
          if (
            kind === "doctor" &&
            (run.result.scope !== "local-configuration" || run.result.checks?.length !== 4)
          )
            throw new Error("Installed host-only Doctor did not return its four checks.");
          break;
        }
        if (Date.now() > runDeadline) throw new Error(`Installed ${kind} did not finish.`);
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    // HTTP MCP from the installed artifact (#390): initialize, list the read tools and read one
    // role briefing through the shared cache, as a real SDK client would.
    const mcp = new Client({ name: "package-test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}mcp`)));
    let mcpSummary: string;
    try {
      const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
      if (!tools.includes("triage_briefing"))
        throw new Error(`Installed HTTP MCP lists no triage_briefing: ${tools.join(", ")}`);
      const briefing = await mcp.callTool({
        name: "triage_briefing",
        arguments: { agent: "package-test", role: "implementer" },
      });
      const envelope = briefing.structuredContent as
        | { status?: string; freshness?: { cache?: { source?: string } } }
        | undefined;
      if (briefing.isError || !envelope || envelope.freshness?.cache?.source !== "live")
        throw new Error(
          `Installed HTTP MCP briefing failed: ${JSON.stringify(briefing).slice(0, 400)}`,
        );
      mcpSummary = `HTTP MCP ${tools.length} tools, briefing ${envelope.status}`;
    } finally {
      await mcp.close();
    }
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 8_000)),
    ]);
    if (code !== 0)
      throw new Error(`Installed pdb serve exited ${String(code)} after SIGTERM, not 0.`);
    return `${first}; ${mcpSummary} (stopped in ${Date.now() - t0}ms)`;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
const parityFields = [
  "actions",
  "role",
  "rankedActions",
  "estimation",
  "impactEstimation",
  "decisionEngine",
] as const;
type Report = Record<string, unknown>;
const rankedKinds = (report: Report): string[] => {
  const ranked = report.rankedActions as { items?: { kind: string; target: string }[] } | null;
  return (ranked?.items ?? []).map((i) => `${i.kind}#${i.target.split("/").pop()}`);
};

/**
 * Installed CLI and installed MCP server must report the same blended role queue (#260,
 * doc/design/mcp.md "Role views"). Returns the ranked kinds for the evidence log.
 */
async function blendedParity(
  cliBin: string,
  mcpCommand: { command: string; args: string[] },
  repository: string,
  role: string,
  order: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  expectedEngine = defaultEngine(),
): Promise<string[]> {
  const cliRun = await run(
    windows ? `"${cliBin}"` : cliBin,
    [
      "--repo",
      repository,
      "--role",
      role,
      "--order",
      order,
      "--limit",
      "10",
      "--json",
      "--no-update-check",
    ],
    { cwd, env, shell: windows, maxBuffer: 64 * 1024 * 1024 },
  );
  const cli = JSON.parse(cliRun.stdout) as Report;
  if ((cli.decisionEngine as { used?: string })?.used !== expectedEngine)
    throw new Error(`Installed engine is not ${expectedEngine}.`);
  if (expectedEngine === "datalog") {
    const ranked = cli.rankedActions as {
      items: { why?: { text?: string; facts?: object }; ruleIds?: string[] }[];
    };
    if (
      !ranked.items.length ||
      ranked.items.some((row) => !row.why?.text || !row.ruleIds?.length || !row.why.facts)
    )
      throw new Error("Installed Datalog reasons lack rule/fact bindings.");
  }
  const transport = new StdioClientTransport({
    command: mcpCommand.command,
    args: [...mcpCommand.args, "--repo", repository, "--project", cwd],
    cwd,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "package-test", version: "1.0.0" });
  await client.connect(transport);
  let mcp: Report;
  let omitted: Record<string, number> = {};
  try {
    const result = await client.callTool({
      name: "triage_briefing",
      arguments: { role, order, limit: 10 },
    });
    // Bounded version-2 envelope (#266): `data` carries the CLI fields; `presentation.omitted`
    // names any list the response budget shortened.
    const structured = result.structuredContent as
      | { status?: string; data?: Report; presentation?: { omitted?: Record<string, number> } }
      | undefined;
    if (!structured?.data)
      throw new Error(`Installed MCP returned no ${role} briefing (${structured?.status}).`);
    mcp = structured.data;
    omitted = structured.presentation?.omitted ?? {};
  } finally {
    await client.close();
  }
  // Shortened lists (by path, including role.next and role.sections[i].items) must be exact
  // CLI prefixes; everything else must be equal (src/mcp/parity.ts).
  for (const key of parityFields) {
    const difference = parityDifference(key, mcp[key], cli[key], omitted);
    if (difference)
      throw new Error(
        `Installed CLI and MCP disagree on ${key} for ${role} (${order}): ${difference}. CLI ${JSON.stringify(cli[key])} MCP ${JSON.stringify(mcp[key])}.`,
      );
  }
  return rankedKinds(cli);
}

/**
 * The bounded project-preference worker (#515) from the installed evaluator chunk, in a separate
 * Node process: the fixed worker entry and its DataScript dependency must resolve from the
 * installed package, with no source checkout. The policy is compiled here because the compiler
 * (and its development-only EDN reader) is deliberately not part of the installed chunk.
 */
async function projectWorkerSmoke(chunk: string, cwd: string): Promise<void> {
  const fixture = await readFile(join(root, "doc/reports/fixtures/project-rules-v1.edn"), "utf8");
  const { rulesHash, policyVersion } = await import("../src/rules/datalog/engine.js");
  const { compileProjectPolicy } = await import("../src/rules/datalog/project/compile.js");
  const policy = compileProjectPolicy(
    fixture.replace(/:base-rules-hash "[0-9a-f]{64}"/, `:base-rules-hash "${rulesHash}"`),
    { policyVersion, rulesHash },
  );
  const action = (n: number) => ({
    id: `o/r https://github.com/o/r/issues/${n} implement`,
    kind: "implement",
    role: "implementer",
    target: `https://github.com/o/r/issues/${n}`,
    band: 6,
    impact: { state: "current", size: "M" },
    complexity: { state: "current", size: "M" },
    unlocks: 0,
    unlocksUnknown: [],
  });
  const input = join(cwd, "project-worker-input.json");
  await writeFile(
    input,
    JSON.stringify({
      policy,
      actions: [action(1), action(2)],
      subjects: [[action(2).target, { labels: ["project:priority"], labelsComplete: true }]],
    }),
  );
  const script = `
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const [chunk, input] = process.argv.slice(1);
    const { evaluateProjectPreferences } = await import(pathToFileURL(chunk).href);
    const { policy, actions, subjects } = JSON.parse(readFileSync(input, "utf8"));
    const result = await evaluateProjectPreferences(policy, actions, new Map(subjects), {
      generation: "package-test",
      viewer: { role: "implementer", order: "impact" },
    });
    process.stdout.write(JSON.stringify(result.items.map((a) => a.target)));
  `;
  const { stdout } = await run(
    process.execPath,
    ["--input-type=module", "-e", script, chunk, input],
    {
      cwd,
    },
  );
  const order = JSON.parse(stdout) as string[];
  if (!order[0]?.endsWith("/issues/2") || order.length !== 2)
    throw new Error(`Installed project worker returned ${stdout}.`);
}

/**
 * Packaged crash frames (#629, doc/design/sentry-crash-reporting.md "Packaged stack
 * locations"). Runs the installed bundle under the test-only preload `scripts/crash-preload.ts`,
 * which records SDK envelopes locally (no network) and throws from a builtin that PDB's own
 * event-listener code calls, so the fault is a real unhandled exception through the installed
 * dist files. The recorded event must carry only mapped public `src/` frames that point at
 * the expected source line, the fixed message, mode, release and environment, and nothing from
 * the thrown error or the machine.
 */
async function packagedCrash(
  kind: "serve" | "mcp",
  packageDir: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  work: string,
  /** Extra process environment, for example NODE_OPTIONS=--enable-source-maps. */
  extra: NodeJS.ProcessEnv = {},
): Promise<string> {
  const capture = join(work, `crash-${kind}-${Object.keys(extra).length}.txt`);
  const preload = pathToFileURL(join(root, "scripts", "crash-preload.ts")).href;
  const entry = join(packageDir, "dist", kind === "serve" ? "cli.mjs" : "mcp.mjs");
  const args =
    kind === "serve"
      ? [entry, "serve", "--repo", "example/parity", "--port", "0"]
      : [entry, "--repo", "example/parity", "--poll"];
  const child = spawn(process.execPath, ["--import", preload, ...args], {
    cwd,
    env: {
      ...env,
      SENTRY_DSN: "https://public@sentry.example.invalid/1",
      SENTRY_DISABLED: "",
      SENTRY_DEBUG: "",
      SENTRY_SPOTLIGHT: "",
      https_proxy: "",
      http_proxy: "",
      PDB_CRASH_CAPTURE: capture,
      PDB_CRASH_TRIGGER: kind === "serve" ? "^GET /healthz " : "exit",
      ...extra,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  const until = async (ready: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!ready()) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`Installed ${kind} crash check: ${what} never happened. stderr: ${stderr}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  let expected: { file: string; text: string };
  if (kind === "serve") {
    await until(() => stdout.includes("\n"), "the banner");
    const url = /listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1];
    await fetch(`${url}healthz`);
    expected = { file: "src/serve.ts", text: "process.stderr.write(text)" };
  } else {
    await until(() => stderr.includes("SIGTERM handler registered"), "polling start");
    child.kill("SIGTERM");
    expected = { file: "src/mcp.ts", text: "process.exit(0)" };
  }
  const code = await Promise.race([
    exited,
    new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 20_000)),
  ]);
  if (code === "timeout") {
    child.kill("SIGKILL");
    throw new Error(`Installed ${kind} did not exit after its fault.`);
  }
  if (code !== 1) throw new Error(`Installed ${kind} fault exited ${code}, not 1.`);
  const recorded = (await readFile(capture, "utf8")).split("\n\u0000\n").filter(Boolean);
  if (recorded.length !== 1)
    throw new Error(`Installed ${kind} sent ${recorded.length} envelopes.`);
  const [header, item, payload] = recorded[0]!.split("\n");
  if (!header || JSON.parse(item ?? "{}").type !== "event" || !payload)
    throw new Error(`Installed ${kind} envelope is not one event: ${recorded[0]!.slice(0, 300)}`);
  for (const leak of ["DO_NOT_SEND", "secret-token", "ghp_", "/Users/private", work, packageDir])
    if (recorded[0]!.includes(leak))
      throw new Error(`Installed ${kind} crash envelope contains ${JSON.stringify(leak)}.`);
  const event = JSON.parse(payload) as {
    level?: string;
    environment?: string;
    release?: string;
    tags?: Record<string, string>;
    exception?: {
      values?: {
        value?: string;
        stacktrace?: { frames?: { filename?: string; lineno?: number }[] };
      }[];
    };
  };
  const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    version: string;
  };
  const exception = event.exception?.values?.[0];
  if (
    event.level !== "fatal" ||
    event.environment !== "node" ||
    event.release !== `pdb@${version}` ||
    JSON.stringify(event.tags) !== JSON.stringify({ mode: kind }) ||
    exception?.value !== crashMessage
  )
    throw new Error(`Installed ${kind} event labels are wrong: ${payload.slice(0, 400)}`);
  const frames = exception.stacktrace?.frames ?? [];
  if (!frames.length || frames.some((f) => !(f.filename ?? "").startsWith("src/")))
    throw new Error(
      `Installed ${kind} frames are not all mapped to src/: ${JSON.stringify(frames)}`,
    );
  // The newest frame (last) must be PDB's own call into the faulting builtin, on the right line.
  const top = frames.at(-1)!;
  const line = (await readFile(join(root, top.filename!), "utf8")).split("\n")[top.lineno! - 1];
  if (top.filename !== expected.file || !line?.includes(expected.text))
    throw new Error(
      `Installed ${kind} top frame ${top.filename}:${top.lineno} is not ${expected.file} (${expected.text}).`,
    );
  return frames.map((f) => `${f.filename}:${f.lineno}`).join(" <- ");
}

/**
 * Installed project preferences (#516): `pdb rules init` and `pdb config set` in a checkout, then
 * the installed CLI briefing, `pdb rules`, the MCP briefing (through blendedParity, which compares
 * decisionEngine) and a `pdb serve --project` briefing and /rules page must all name the same
 * active effective revision, without a source checkout or development dependency.
 */
async function projectRulesParity(
  bin: string,
  mcpCommand: { command: string; args: string[] },
  env: NodeJS.ProcessEnv,
  checkout: string,
): Promise<string> {
  await run(bin, ["rules", "init"], { cwd: checkout, env });
  const before = JSON.parse(
    (await run(bin, ["rules", "--json"], { cwd: checkout, env })).stdout,
  ) as {
    effectivePolicy: { state: string };
  };
  if (before.effectivePolicy.state !== "disabled")
    throw new Error(
      `A pdb.rules.edn file alone changed the policy: ${before.effectivePolicy.state}.`,
    );
  await run(bin, ["config", "set", "rules.project.enabled", "true"], { cwd: checkout, env });
  try {
    const rules = JSON.parse(
      (await run(bin, ["rules", "--json"], { cwd: checkout, env })).stdout,
    ) as {
      effectivePolicy: { state: string; effectiveRulesHash: string };
    };
    const hash = rules.effectivePolicy.effectiveRulesHash;
    if (rules.effectivePolicy.state !== "active" || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`Installed pdb rules does not report an active project policy.`);
    const briefing = JSON.parse(
      (
        await run(
          bin,
          ["--repo", "example/parity", "--role", "implementer", "--json", "--no-update-check"],
          { cwd: checkout, env, maxBuffer: 64 * 1024 * 1024 },
        )
      ).stdout,
    ) as { decisionEngine: { rulesHash: string; effectivePolicy?: { state: string } } };
    if (
      briefing.decisionEngine.rulesHash !== hash ||
      briefing.decisionEngine.effectivePolicy?.state !== "active"
    )
      throw new Error("Installed CLI briefing and pdb rules name different effective revisions.");
    // MCP: blendedParity fails unless its decisionEngine (with effectivePolicy) equals the CLI's.
    await blendedParity(bin, mcpCommand, "example/parity", "implementer", "impact", env, checkout);
    const child = spawn(bin, ["serve", "--project", checkout, "--port", "0"], {
      cwd: checkout,
      env: { ...env, PDB_FAKE_REPO_VIEW: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (t: string) => (stdout += t));
    child.stderr.setEncoding("utf8").on("data", (t: string) => (stderr += t));
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes("\n")) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`pdb serve --project printed no banner. stderr: ${stderr}`);
        await new Promise((done) => setTimeout(done, 50));
      }
      const url = /listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1];
      const served = (await (
        await fetch(`${url}api/v1/briefing?repo=example%2Fparity&role=implementer`)
      ).json()) as { result?: { decisionEngine?: { rulesHash?: string } } };
      if (served.result?.decisionEngine?.rulesHash !== hash)
        throw new Error("Installed pdb serve briefing names a different effective revision.");
      const page = await (await fetch(`${url}rules?repo=example%2Fparity`)).text();
      if (!page.includes(hash) || !page.includes("Project preferences"))
        throw new Error("Installed /rules page does not show the effective project policy.");
    } finally {
      child.kill("SIGTERM");
    }
    return hash.slice(0, 12);
  } finally {
    await run(bin, ["config", "set", "rules.project.enabled", "false"], { cwd: checkout, env });
  }
}

const work = await mkdtemp(join(tmpdir(), "triage-package-"));
try {
  const { stdout } = await npm(
    ["pack", "--json", "--pack-destination", work, "--ignore-scripts"],
    root,
  );
  const packed = parsePack(stdout);
  const files = packed.files.map((f) => f.path).sort();
  const engineChunks = files.filter((p) => /^dist\/datalog-[A-Za-z0-9_-]+\.mjs$/.test(p));
  // The CLI and MCP entries are built separately; each references one lazy evaluator chunk, which
  // may be the same file. Every chunk an entry imports must be packaged, and nothing else.
  const referenced = new Set<string>();
  for (const entry of ["dist/cli.mjs", "dist/mcp.mjs"])
    for (const m of (await readFile(join(root, entry), "utf8")).matchAll(
      /import\("\.\/(datalog-[A-Za-z0-9_-]+\.mjs)"\)/g,
    ))
      referenced.add(`dist/${m[1]}`);
  if (
    engineChunks.length < 1 ||
    engineChunks.length > 2 ||
    JSON.stringify([...referenced].sort()) !== JSON.stringify(engineChunks)
  )
    throw new Error(
      `Packaged evaluator chunks ${JSON.stringify(engineChunks)} differ from those the entries load ${JSON.stringify([...referenced])}.`,
    );
  // The native query seam shares pure policy and factual-normalization chunks with the lazy
  // evaluator (#676). Follow their actual import graph, so no referenced helper can be omitted.
  const runtimeChunks = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    for (const match of (await readFile(join(root, file), "utf8")).matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']\.\/((?:datalog|engine|requiredchecks|english-render)-[A-Za-z0-9_-]+\.mjs)["']/g,
    )) {
      const child = `dist/${match[1]}`;
      if (runtimeChunks.has(child)) continue;
      if (!files.includes(child))
        throw new Error(`Referenced runtime chunk ${child} is not packaged.`);
      runtimeChunks.add(child);
      await visit(child);
    }
  };
  await visit("dist/cli.mjs");
  await visit("dist/mcp.mjs");
  const expectedFiles = [
    ...expected,
    ...runtimeChunks,
    ...[...runtimeChunks].map((c) => `${c}.map`),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    throw new Error(
      `Archive contents ${JSON.stringify(files)} differ from ${JSON.stringify(expectedFiles)}.`,
    );
  console.log(`ok   archive ${packed.filename} contains exactly the allowlisted files`);

  // The recommended installation is global (#17): one executable serves many checkouts.
  // Install into an isolated temporary prefix so the test never touches the real global tree.
  const prefix = join(work, "prefix");
  await npm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      join(work, packed.filename),
    ],
    work,
  );
  const packageDir = windows
    ? join(prefix, "node_modules", ...packed.name.split("/"))
    : join(prefix, "lib", "node_modules", ...packed.name.split("/"));
  // Only optional fields are read, each through optional chaining, so any JSON shape is safe.
  const manifest: { license?: string; scripts?: Record<string, unknown> } | null = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  if (manifest?.license !== "GPL-3.0-or-later")
    throw new Error("Installed package must identify the owner-selected GPL-3.0-or-later license.");
  if (manifest?.scripts?.postinstall || manifest?.scripts?.install || manifest?.scripts?.preinstall)
    throw new Error("The package must not run install scripts on installation.");
  console.log("ok   installed globally into an isolated prefix without install scripts");
  for (const file of expectedFiles.filter((f) => f.endsWith(".map"))) {
    const map = JSON.parse(await readFile(join(packageDir, file), "utf8")) as {
      sources?: unknown[];
      sourcesContent?: unknown;
    };
    const bundle = await readFile(join(packageDir, file.slice(0, -".map".length)), "utf8");
    if (/\/\/# sourceMappingURL=/.test(bundle))
      throw new Error(`Installed ${file} is referenced by its bundle; Node would discover it.`);
    if (
      map.sourcesContent !== undefined ||
      !map.sources?.every((s) => typeof s === "string" && s.startsWith("../src/"))
    )
      throw new Error(`Installed ${file} embeds source text or names a non-public path.`);
  }
  console.log(
    "ok   installed source maps name only public ../src/ paths, embed no source and are not referenced",
  );
  await nativeStopSmoke(join(packageDir, "dist", "cli.mjs"), work);
  console.log(
    "ok   installed native Codex adapter: stdin, literal args, framing and deadline outside checkout",
  );
  for (const chunk of engineChunks) await projectWorkerSmoke(join(packageDir, chunk), work);
  console.log("ok   installed evaluator runs a project-preference worker from its own chunk");

  const bin = windows ? join(prefix, "pdb.cmd") : join(prefix, "bin", "pdb");
  // Compatibility aliases are deliberately not renamed: existing launchers keep working.
  for (const [legacyName, canonicalName] of [
    ["github-triage", "pdb"],
    ["github-triage-mcp", "pdb-mcp"],
  ]) {
    const legacyBin = windows ? join(prefix, `${legacyName}.cmd`) : join(prefix, "bin", legacyName);
    const { stdout } = await run(windows ? `"${legacyBin}"` : legacyBin, ["--help"], {
      shell: windows,
    });
    if (!stdout.startsWith(`Usage: ${canonicalName}`))
      throw new Error(`Legacy alias ${legacyName} does not resolve to ${canonicalName}.`);
  }
  console.log("ok   legacy executable aliases resolve to the canonical PDB commands");
  // Separate working directories stand in for different project checkouts.
  const checkouts = [join(work, "checkout-a"), join(work, "checkout-b")];
  for (const dir of checkouts) await mkdir(dir);
  for (const cwd of checkouts) {
    // With shell: true, Windows needs the .cmd path quoted (temporary paths may contain spaces).
    const cli = (args: string[]) => run(windows ? `"${bin}"` : bin, args, { cwd, shell: windows });
    const help = await cli(["--help"]);
    if (!help.stdout.startsWith("Usage:"))
      throw new Error(`Installed bin printed no help in ${cwd}.`);
    // Blended role queues (#259): help names the ranked queue and its assessment kinds.
    if (!help.stdout.includes("rankedActions") || !help.stdout.includes("estimate-complexity"))
      throw new Error(`Installed bin help does not describe the blended queue in ${cwd}.`);
    // The bundled complexity guidance must ship inside the packed artifact.
    const guidance = await cli(["estimate", "--help"]);
    if (!/XS[\s\S]*XXL/.test(guidance.stdout) || !guidance.stdout.includes("guidance (version"))
      throw new Error(`Installed bin printed no complexity guidance in ${cwd}.`);
    // Labels-only complexity (#153): the installed artifact names label storage and no field setup.
    if (!guidance.stdout.includes("complexity:XS"))
      throw new Error(`Installed complexity guidance does not describe size labels in ${cwd}.`);
    // Impact estimates (#245): the installed help documents --metric impact and its marker.
    if (
      !help.stdout.includes("--metric impact") ||
      !guidance.stdout.includes("--metric METRIC") ||
      !guidance.stdout.includes("github-triage:impact-estimate v1")
    )
      throw new Error(`Installed bin does not document impact estimates in ${cwd}.`);
    // Impact guidance (#246): the bundled impact definition ships and renders as text and JSON.
    const impactHelp = await cli(["estimate", "--help", "--metric", "impact"]);
    const impactJson = await cli(["estimate", "--help", "--metric", "impact", "--json"]);
    if (
      !impactHelp.stdout.includes("Impact estimation guidance (version") ||
      !impactHelp.stdout.includes("impact:XS") ||
      !help.stdout.includes("estimate --help --metric impact") ||
      (JSON.parse(impactJson.stdout) as { kind?: string }).kind !== "impact-guidance"
    )
      throw new Error(`Installed bin printed no impact guidance in ${cwd}.`);
    if (/setup complexity|issue field|fieldId/.test(help.stdout + guidance.stdout))
      throw new Error(`Installed bin still advertises retired native-field setup in ${cwd}.`);
    // Repository briefing mode (#170): the installed help documents the mode and its windows.
    const catchUpHelp = await cli(["briefing", "--help"]);
    if (
      !help.stdout.includes("briefing [--last 24h") ||
      !["--last", "--since", "--checkpoint", "--offline", "Scope:"].every((term) =>
        catchUpHelp.stdout.includes(term),
      )
    )
      throw new Error(`Installed bin does not document briefing mode in ${cwd}.`);
    // Delivery records (#189): the installed help documents every deliverables command.
    const deliverablesHelp = await cli(["deliverables", "--help"]);
    if (
      !help.stdout.includes("deliverables N attach") ||
      ![
        "attach",
        "detach",
        "retarget",
        "handoff",
        "membership",
        "attest",
        "reassign",
        "reset",
        "void",
        "--legacy",
        "TARGET_MISMATCH",
      ].every((term) => deliverablesHelp.stdout.includes(term))
    )
      throw new Error(`Installed bin does not document deliverables commands in ${cwd}.`);
    // pdb quotas (#547): the installed help documents the command and its flags.
    const quotasHelp = await cli(["quotas", "--help"]);
    if (
      !help.stdout.includes("quotas [--json] [--refresh | --offline]") ||
      !["--json", "--refresh", "--offline", "unmetered", "/rate_limit"].every((term) =>
        quotasHelp.stdout.includes(term),
      )
    )
      throw new Error(`Installed bin does not document pdb quotas in ${cwd}.`);
    const invalid = await cli(["--no-such-option"]).then(
      () => null,
      (error: { code?: unknown }) => error,
    );
    if (invalid?.code !== 1)
      throw new Error(`Invalid arguments exited ${invalid?.code ?? 0}, not 1, in ${cwd}.`);
    // Reuse the credential-free smoke checks (offline fixtures, unreachable gh) on the
    // globally installed copy, run from this working directory.
    await run(
      process.execPath,
      [
        // The smoke script is TypeScript, run through the development-only tsx loader; the
        // CLI under test is the installed compiled artifact.
        "--import",
        import.meta.resolve("tsx"),
        join(root, "scripts", "smoke.ts"),
        join(packageDir, "dist", "cli.mjs"),
      ],
      {
        cwd,
      },
    );
  }
  console.log(
    "ok   global bin works from separate working directories (help, guidance, invalid args, smoke)",
  );
  // The second bin (#25): a real SDK client completes a stdio round trip with the installed
  // MCP server. Listing tools needs no GitHub access or credentials.
  const mcpBin = windows ? join(prefix, "pdb-mcp.cmd") : join(prefix, "bin", "pdb-mcp");
  const transport = new StdioClientTransport({
    command: windows ? process.execPath : mcpBin,
    args: windows
      ? [join(packageDir, "dist", "mcp.mjs"), "--repo", "example/example"]
      : ["--repo", "example/example"],
    cwd: checkouts[0],
    stderr: "pipe",
  });
  const client = new Client({ name: "package-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const want = ["triage_briefing", "triage_dependencies", "triage_events", "triage_issue"];
    if (JSON.stringify(names) !== JSON.stringify(want))
      throw new Error(
        `Installed MCP bin listed ${JSON.stringify(names)}, not ${JSON.stringify(want)}.`,
      );
    if (!tools.every((t) => t.annotations?.readOnlyHint === true))
      throw new Error("Installed MCP tools must all be annotated read-only.");
  } finally {
    await client.close();
  }
  const mcpHelp = await run(windows ? `"${join(prefix, "pdb-mcp.cmd")}"` : mcpBin, ["--help"], {
    shell: windows,
  });
  if (!mcpHelp.stdout.startsWith("Usage: pdb-mcp"))
    throw new Error("Installed MCP bin printed no help.");
  // #246: MCP help carries the same bundled impact guidance and the CLI commands for it.
  if (
    !mcpHelp.stdout.includes("Impact estimation guidance (version") ||
    !mcpHelp.stdout.includes("pdb estimate --help --metric impact")
  )
    throw new Error("Installed MCP help carries no impact guidance.");
  console.log("ok   installed pdb-mcp completes a stdio round trip (four read-only tools)");
  // #260: installed CLI and MCP produce identical blended role queues from the same facts.
  const mcpCommand = windows
    ? { command: process.execPath, args: [join(packageDir, "dist", "mcp.mjs")] }
    : { command: mcpBin, args: [] };
  // pdb serve (#373, #805): the installed bin exits 2 with guidance when nothing is servable.
  // Resolution now also considers saved registrations and the checkout, so this runs from a
  // disposable non-repository directory with an isolated PDB_CONFIG_DIR: otherwise a real user
  // configuration or the caller's checkout would legitimately supply a repository to serve.
  const serveEmpty = await mkdtemp(join(tmpdir(), "pdb-serve-empty-"));
  const serveUsage = await run(windows ? `"${bin}"` : bin, ["serve"], {
    shell: windows,
    cwd: serveEmpty,
    env: { ...process.env, PDB_CONFIG_DIR: join(serveEmpty, "config") },
  }).then(
    () => null,
    (error: { code?: unknown; stderr?: unknown }) => error,
  );
  if (serveUsage?.code !== 2 || !String(serveUsage.stderr).includes("nothing to serve"))
    throw new Error(
      `Installed pdb serve with nothing to serve exited ${JSON.stringify(serveUsage?.code ?? 0)}, not 2.`,
    );
  const serveHelpText = await run(windows ? `"${bin}"` : bin, ["serve", "--help"], {
    shell: windows,
  });
  if (!serveHelpText.stdout.startsWith("Usage: pdb serve"))
    throw new Error("Installed pdb serve printed no help.");
  console.log("ok   installed pdb serve validates arguments (exit 2) and prints help");
  // pdb rules (#416): the compiled policy from the installed package, outside any checkout, with
  // no GitHub CLI or credentials on PATH. Complete stdout; errors only on stderr with exit 2.
  {
    const outside = join(work, "rules-outside");
    await mkdir(outside);
    const bare: NodeJS.ProcessEnv = {
      SENTRY_DISABLED: "1",
      PATH: dirname(process.execPath),
      PDB_NO_UPDATE_CHECK: "1",
      PDB_NO_FIRST_USE_HINT: "1",
      PDB_NO_HUMAN_CONTEXT: "1",
      PDB_NO_EFFECTIVE_IDENTITY: "1",
      ...(windows ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    };
    const rules = (rulesArgs: string[]) =>
      run(windows ? `"${bin}"` : bin, ["rules", ...rulesArgs], {
        cwd: outside,
        env: bare,
        shell: windows,
        maxBuffer: 64 * 1024 * 1024,
      });
    const listing = await rules([]);
    const lines = listing.stdout.split("\n");
    if (
      lines[0] !== "# `pdb rules` — Compiled Policy" ||
      !listing.stdout.includes("- Policy: version ") ||
      !listing.stdout.includes("## Not formalized here") ||
      !/Coverage of the full policy: \d+ decision rules/.test(listing.stdout) ||
      !listing.stdout.endsWith("\n") ||
      listing.stderr !== ""
    )
      throw new Error("Installed pdb rules printed no complete listing outside a checkout.");
    const document = JSON.parse((await rules(["--json", "--role", "designer"])).stdout) as {
      schemaVersion?: number;
      scope?: { complete?: boolean; filters?: { role?: string } };
      decisions?: { id: string }[];
    };
    if (
      document.schemaVersion !== 1 ||
      document.scope?.complete !== false ||
      document.scope.filters?.role !== "designer" ||
      !document.decisions?.some((d) => d.id === "D-DESIGN")
    )
      throw new Error("Installed pdb rules --json --role designer is not a labelled subset.");
    const unknown = await rules(["--rule", "D-NO-SUCH-RULE"]).then(
      () => null,
      (error: { code?: unknown; stdout?: unknown; stderr?: unknown }) => error,
    );
    if (
      unknown?.code !== 2 ||
      unknown.stdout !== "" ||
      !String(unknown.stderr).includes("unknown rule or predicate")
    )
      throw new Error("Installed pdb rules --rule with an unknown ID must fail on stderr, exit 2.");
    if (!(await rules(["--help"])).stdout.startsWith("Usage: pdb rules"))
      throw new Error("Installed pdb rules printed no help.");
    console.log(
      `ok   installed pdb rules outside a checkout, no gh or credentials: ${lines.length} lines; --json --role filter labelled; unknown --rule exits 2 on stderr`,
    );
    // pdb onboard (#351): read-only instructions outside a checkout, with no gh or credentials.
    const onboard = (args: string[]) =>
      run(windows ? `"${bin}"` : bin, ["onboard", ...args], {
        cwd: outside,
        env: bare,
        shell: windows,
      });
    const onboarding = JSON.parse((await onboard(["--repo", "owner/name", "--json"])).stdout) as {
      kind?: string;
      repository?: string;
      persistentSection?: string;
    };
    if (
      onboarding.kind !== "onboarding" ||
      onboarding.repository !== "owner/name" ||
      !onboarding.persistentSection?.startsWith("<!-- pdb:coordination:start -->") ||
      (await readdir(outside)).length !== 0
    )
      throw new Error(
        "Installed pdb onboard --json printed no read-only document outside a checkout.",
      );
    const refused = await onboard(["--install"]).then(
      () => null,
      (error: { code?: unknown }) => error,
    );
    if (refused?.code !== 2 || (await readdir(outside)).length !== 0)
      throw new Error(
        "Installed pdb onboard --install outside a checkout must exit 2 and write nothing.",
      );
    console.log(
      "ok   installed pdb onboard outside a checkout: read-only document; --install exits 2",
    );
  }
  if (windows)
    // execFile("gh") resolves only gh.exe on Windows, so a script stand-in cannot be found.
    console.log(
      "skip installed blended-queue parity and pdb serve smoke with a fake gh (not supported on Windows)",
    );
  else {
    // A checkout of the fixture repository, so repository configuration resolves (absent).
    const checkout = join(work, "parity-checkout");
    await mkdir(checkout);
    await run("git", ["init", "-q"], { cwd: checkout });
    await run("git", ["remote", "add", "origin", "https://github.com/example/parity.git"], {
      cwd: checkout,
    });
    // #768: installed pdb install codex / uninstall codex lifecycle in a fresh git checkout.
    const installCheckout = join(work, "codex-install-checkout");
    await mkdir(installCheckout);
    await run("git", ["init", "-q"], { cwd: installCheckout });
    await run("git", ["remote", "add", "origin", "https://github.com/example/codex-install.git"], {
      cwd: installCheckout,
    });
    const installEnv = {
      ...process.env,
      HOME: join(work, "install-home"),
      PDB_NO_UPDATE_CHECK: "1",
      PDB_NO_FIRST_USE_HINT: "1",
      PDB_NO_HUMAN_CONTEXT: "1",
      PDB_NO_EFFECTIVE_IDENTITY: "1",
    };
    await mkdir(installEnv.HOME);
    const runInstall = (cmdArgs: string[]) =>
      run(bin, cmdArgs, { cwd: installCheckout, env: installEnv });
    const first = JSON.parse(
      (await runInstall(["install", "codex", "--role", "implementer", "--yes", "--json"])).stdout,
    ) as {
      status?: { configured?: boolean };
      items?: { kind: string; action: string; outcome: string }[];
    };
    if (
      first.status?.configured !== true ||
      !first.items?.some((i) => i.kind === "identity" && i.outcome === "applied") ||
      !first.items?.some((i) => i.kind === "mcp" && i.outcome === "applied")
    )
      throw new Error(`Installed pdb install codex first run failed: ${JSON.stringify(first)}`);
    const rerun = JSON.parse(
      (await runInstall(["install", "codex", "--role", "implementer", "--yes", "--json"])).stdout,
    ) as { items?: { kind: string; outcome: string }[] };
    if (!rerun.items?.some((i) => i.kind === "mcp" && i.outcome === "kept"))
      throw new Error(`Installed pdb install codex rerun failed: ${JSON.stringify(rerun)}`);
    const updated = JSON.parse(
      (
        await runInstall([
          "install",
          "codex",
          "--transport",
          "http",
          "--url",
          "https://example.com/mcp",
          "--yes",
          "--json",
        ])
      ).stdout,
    ) as { items?: { kind: string; action: string; outcome: string }[] };
    if (
      !updated.items?.some(
        (i) => i.kind === "mcp" && i.action === "replace" && i.outcome === "applied",
      )
    )
      throw new Error(`Installed pdb install codex update failed: ${JSON.stringify(updated)}`);
    const removed = JSON.parse(
      (await runInstall(["uninstall", "codex", "--yes", "--json"])).stdout,
    ) as { items?: { kind: string; action: string; outcome: string }[] };
    if (
      !removed.items?.some(
        (i) => i.kind === "mcp" && i.action === "remove" && i.outcome === "applied",
      )
    )
      throw new Error(`Installed pdb uninstall codex failed: ${JSON.stringify(removed)}`);
    console.log(
      "ok   installed pdb install/uninstall codex in checkout: first, rerun, http update, remove",
    );
    const fakeDir = join(work, "fake-gh");
    await mkdir(fakeDir);
    await writeFile(join(fakeDir, "gh"), fakeGh);
    await chmod(join(fakeDir, "gh"), 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ""}`,
      PDB_NO_UPDATE_CHECK: "1",
      PDB_NO_FIRST_USE_HINT: "1",
      PDB_NO_HUMAN_CONTEXT: "1",
      PDB_NO_EFFECTIVE_IDENTITY: "1",
    };
    await nativeStopSmoke(join(packageDir, "dist", "cli.mjs"), work, env, true);
    console.log("ok   installed native Codex offer and duplicate guard with fake gh");
    console.log(`ok   installed pdb serve: ${await serveSmoke(bin, env, work)}`);
    for (const kind of ["serve", "mcp"] as const)
      console.log(
        `ok   installed ${kind} unhandled fault reports mapped public frames only: ${await packagedCrash(kind, packageDir, env, checkout, work)}`,
      );
    console.log(
      `ok   installed default-on reporting uses only the intercepted transport: ${await packagedCrash(
        "serve",
        packageDir,
        env,
        checkout,
        work,
        {
          SENTRY_DSN: undefined,
          PDB_CRASH_INGEST_HOST: new URL(defaultCrashDsn).hostname,
          HOME: work,
          USERPROFILE: work,
          APPDATA: join(work, "appdata"),
          XDG_CONFIG_HOME: join(work, "config"),
        },
      )}`,
    );
    // The real installed entrypoints read the opt-out before resolving the SDK.
    {
      const marker = join(work, "unexpected-sdk-load");
      const privateHome = await realpath(work);
      const preload = join(work, "config-opt-out.mjs");
      // Locate the dependency from the installed package, independent of npm hoisting.
      const { createRequire } = await import("node:module");
      const requireInstalled = createRequire(join(packageDir, "package.json"));
      const pathsUrl = pathToFileURL(requireInstalled.resolve("env-paths"));
      await writeFile(
        preload,
        `import paths from ${JSON.stringify(pathsUrl.href)};
        import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {registerHooks} from 'node:module';
        const dir=paths('presidential-daily-briefing').config;mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'crash-reporting.toml'),'[telemetry.crashes]\\nenabled='+String(process.env.PDB_TEST_CRASH_ENABLE==='1'));
        registerHooks({resolve(specifier,context,next){if(specifier==='@sentry/node')writeFileSync(${JSON.stringify(marker)},'loaded');return next(specifier,context);}});`,
      );
      const optOutEnv = {
        ...env,
        SENTRY_DISABLED: "",
        SENTRY_DSN: "https://public@sentry.example.invalid/1",
        HOME: privateHome,
        USERPROFILE: privateHome,
        APPDATA: join(privateHome, "appdata"),
        XDG_CONFIG_HOME: join(privateHome, "config"),
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      };
      for (const name of ["cli", "mcp"])
        await run(process.execPath, [join(packageDir, "dist", `${name}.mjs`), "--help"], {
          env: optOutEnv,
          cwd: work,
        });
      await serveSmoke(bin, optOutEnv, work);
      if (
        await readFile(marker, "utf8").then(
          () => true,
          () => false,
        )
      )
        throw new Error("Configured opt-out loaded the SDK");
      await run(process.execPath, [join(packageDir, "dist", "cli.mjs"), "--help"], {
        env: { ...optOutEnv, PDB_TEST_CRASH_ENABLE: "1" },
        cwd: work,
      });
      if (
        !(await readFile(marker, "utf8").then(
          () => true,
          () => false,
        ))
      )
        throw new Error("SDK-resolution oracle missed the enabled positive control");
      console.log(
        "ok   installed CLI, STDIO MCP and HTTP serve config opt-out never resolve the SDK",
      );
    }
    // Node's own source-map support must not rewrite installed frames to unpackaged src/ paths.
    console.log(
      `ok   installed serve fault with NODE_OPTIONS=--enable-source-maps keeps the same frames: ${await packagedCrash("serve", packageDir, env, checkout, work, { NODE_OPTIONS: "--enable-source-maps" })}`,
    );
    // pdb quotas (#547): the installed command reads one /rate_limit plus one identity read
    // through the fake gh, from any directory, and its text and JSON agree.
    const quotasJson = await run(bin, ["quotas", "--json"], { cwd: work, env });
    const quotaView = JSON.parse(quotasJson.stdout) as {
      kind?: string;
      account?: string;
      requests?: { quota: number; context: number };
      resources?: { resource: string; state: string }[];
      secondary?: { statement?: string };
    };
    if (
      quotaView.kind !== "quota-view" ||
      quotaView.account !== "package-test" ||
      quotaView.requests?.quota !== 1 ||
      quotaView.requests.context !== 1 ||
      quotaView.resources?.find((r) => r.resource === "graphql")?.state !== "critical" ||
      quotaView.secondary?.statement !== "Secondary limits: unmetered"
    )
      throw new Error(`Installed pdb quotas --json is wrong: ${quotasJson.stdout.slice(0, 400)}`);
    const quotasText = await run(bin, ["quotas"], { cwd: work, env });
    if (
      !quotasText.stdout.includes("GraphQL: 4900 / 5000 points used (98%)") ||
      !quotasText.stdout.includes("Secondary limits: unmetered")
    )
      throw new Error(`Installed pdb quotas text is wrong: ${quotasText.stdout.slice(0, 400)}`);
    console.log(
      "ok   installed pdb quotas: text and JSON from one /rate_limit and one identity read",
    );
    const want: Record<string, string> = {
      implementer: "estimate-complexity",
      designer: "assess-impact",
    };
    for (const role of ["implementer", "designer"])
      for (const order of ["impact", "oldest"]) {
        const kinds = await blendedParity(
          bin,
          mcpCommand,
          "example/parity",
          role,
          order,
          env,
          checkout,
        );
        if (!kinds.some((k) => k.startsWith(want[role]!)))
          throw new Error(
            `Installed ${role} queue has no ${want[role]} action: ${kinds.join(", ")}.`,
          );
        console.log(`ok   installed CLI = MCP ${role} (${order}): ${kinds.join(", ")}`);
      }
    console.log(
      `ok   installed project preferences: CLI, pdb rules, MCP, serve and /rules name ${await projectRulesParity(bin, mcpCommand, env, checkout)}`,
    );
    await run(bin, ["config", "set", "briefing.engine", "typescript"], { cwd: checkout, env });
    for (const role of ["implementer", "designer"])
      for (const order of ["impact", "oldest"]) {
        const kinds = await blendedParity(
          bin,
          mcpCommand,
          "example/parity",
          role,
          order,
          env,
          checkout,
          "typescript",
        );
        console.log(
          `ok   installed TypeScript rollback CLI = MCP ${role} (${order}): ${kinds.join(", ")}`,
        );
      }
  }
  // Optional read-only live smoke (#260): GITHUB_TRIAGE_PACKAGE_LIVE_REPO=owner/name uses the
  // real authenticated gh from this checkout. No labels, claims or other writes are made.
  const live = process.env.PDB_PACKAGE_LIVE_REPO ?? process.env.GITHUB_TRIAGE_PACKAGE_LIVE_REPO;
  if (live) {
    const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const version = (
      await run(windows ? `"${bin}"` : bin, ["version", "--no-update-check"], { shell: windows })
    ).stdout.split("\n")[0];
    console.log(`live source revision ${revision}; executable ${bin} (${version})`);
    const env = {
      ...process.env,
      PDB_NO_UPDATE_CHECK: "1",
      PDB_NO_FIRST_USE_HINT: "1",
      PDB_NO_HUMAN_CONTEXT: "1",
      PDB_NO_EFFECTIVE_IDENTITY: "1",
    };
    const selected = await resolveEngineSetting(live, { cwd: root });
    for (const role of ["implementer", "designer"]) {
      const kinds = await blendedParity(
        bin,
        mcpCommand,
        live,
        role,
        "impact",
        env,
        root,
        selected.requested,
      );
      console.log(`ok   live ${live} installed CLI = MCP ${role}: ${kinds.join(", ")}`);
    }
  }
  console.log("Package test passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
