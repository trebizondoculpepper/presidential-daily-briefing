/**
 * The agent setup page (#391): the same onboarding document as `pdb onboard`, with the server's
 * real origin and the selected project; honest client labels; read-only, no GitHub request, no
 * inline script; and the served-project allowlist.
 */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { onboardingDocument } from "../briefing/onboarding.js";
import { systemClock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";
import { clientExamples, setupScript } from "./setup-page.js";

const unescape = (html: string) =>
  html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Every copyable block, unescaped. */
const blocks = (html: string) =>
  [
    ...html.matchAll(
      /<pre class="rules" id="copy-\d+" data-copy aria-label="([^"]*)">([\s\S]*?)<\/pre>/g,
    ),
  ].map((m) => ({ label: unescape(m[1]!), text: unescape(m[2]!) }));

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function call(port: number, path: string, method = "GET"): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

/** A server whose every GitHub boundary records the call, so a page load can prove none. */
async function server(args: string[]) {
  const github: string[] = [];
  const record = (name: string) => (): never => {
    github.push(name);
    throw new Error(`${name} must not be called by the setup page`);
  };
  const runtime: ServeRuntime = {
    currentRepository: async () => "example/project",
    authContext: async () => ({ host: "github.com", login: "octo" }),
    clock: systemClock,
    stdout: () => {},
    stderr: () => {},
    signals: new EventEmitter(),
    exit: () => {},
    version: async () => "9.9.9",
    platform: "linux",
  };
  const read: ServeReadRuntime = {
    collect: record("collect"),
    dependencyReport: record("dependencyReport"),
    rest: record("rest"),
    queryWith: record("queryWith"),
    collectIssueFocus: record("collectIssueFocus"),
    now: () => new Date(),
    env: {},
  };
  const options = serveArguments(["--port", "0", ...args]);
  const running = await startServe(options, runtime, readServices(options, runtime, read));
  return { running, github, port: running.port };
}

describe("GET /setup (#391)", () => {
  it("renders the shared onboarding document for the selected project and the real origin", async () => {
    const { running, github, port } = await server([
      "--repo",
      "example/project",
      "--repo",
      "other/repo",
    ]);
    try {
      const origin = `http://127.0.0.1:${port}`;
      const reply = await call(port, "/setup?repo=example%2Fproject&role=designer");
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.headers["content-security-policy"]).toContain("script-src 'self'");
      // Only the shared selector and same-origin copy helper; no inline scripts.
      expect(reply.body.match(/<script[^>]*>/g)).toEqual([
        '<script src="/project-selection.js" defer>',
        '<script src="/setup.js" defer>',
      ]);
      expect(reply.body).not.toMatch(/\sstyle=|\son[a-z]+=/);
      const doc = onboardingDocument({
        repository: "example/project",
        role: "designer",
        server: origin,
      });
      const shown = blocks(reply.body);
      expect(shown.find((b) => b.label === "Prompt")?.text).toBe(doc.prompt);
      expect(shown.find((b) => b.label === "AGENTS.md section")?.text).toBe(doc.persistentSection);
      // The prompt leads with this server's onboarding and rules pages for the project.
      expect(doc.prompt.split("\n")[2]).toContain(`${origin}/setup?repo=example%2Fproject`);
      expect(doc.prompt.split("\n")[2]).toContain(`${origin}/rules?repo=example%2Fproject`);
      // The MCP endpoint is this server's, and the verified Claude Code command uses it.
      expect(unescape(reply.body)).toContain(`claude mcp add --transport http pdb ${origin}/mcp`);
      expect(reply.body).toContain(`href="${origin}/rules?repo=example%2Fproject"`);
      expect(reply.body).toContain(`href="/setup?repo=other%2Frepo"`);
      expect(reply.body).toContain("unverified");
      expect(github).toEqual([]);
      expect((await call(port, "/setup.js")).body).toBe(setupScript());
    } finally {
      await running.close();
    }
  });

  it("uses placeholders with a selector when several projects are served and none is selected", async () => {
    const { running, port } = await server(["--repo", "example/project", "--repo", "other/repo"]);
    try {
      const reply = await call(port, "/setup");
      expect(reply.status).toBe(200);
      expect(reply.body).toContain("No project selected");
      expect(unescape(reply.body)).toContain("--repo OWNER/NAME");
    } finally {
      await running.close();
    }
  });

  it("refuses unserved, malformed, unknown inputs and writes", async () => {
    const { running, github, port } = await server(["--repo", "example/project"]);
    try {
      const unserved = await call(port, "/setup?repo=evil/repo");
      expect(unserved.status).toBe(403);
      expect(unserved.body).toContain("not served by this server");
      expect(unserved.body).not.toContain("Give your agent");
      expect((await call(port, "/setup?repo=%3Cscript%3E")).status).toBe(400);
      expect((await call(port, "/setup?role=human")).status).toBe(400);
      expect((await call(port, "/setup?other=1")).status).toBe(400);
      expect((await call(port, "/setup", "POST")).status).toBe(405);
      expect(github).toEqual([]);
    } finally {
      await running.close();
    }
  });
});

describe("setup page client examples (#391)", () => {
  it("labels only clients with recorded acceptance as verified", () => {
    const examples = clientExamples("http://127.0.0.1:1/mcp");
    const verified = examples.filter((e) => e.status === "verified");
    for (const e of verified) expect(e.evidence).toMatch(/doc\/reports\//);
    const ori = examples.find((e) => e.client.includes("Ori"));
    expect(ori?.status).toBe("unverified");
    expect(examples.find((e) => e.client.startsWith("Codex"))?.evidence).toContain("#397");
  });
});
