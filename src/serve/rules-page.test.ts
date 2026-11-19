/**
 * The project rules page (#392): the same compiled document as `pdb rules`, rendered from one
 * model; escaping; Host/Origin; unknown projects; effective settings known versus unknown; and
 * no GitHub request while loading it.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { systemClock } from "../mcp/polling.js";
import { buildPolicy, policyDir } from "../rules/datalog/build.js";
import { compileEnglish } from "../rules/datalog/english.js";
import { rulesDocument, rulesFormalText, shippedModel } from "../rules/datalog/rules-command.js";
import type { EffectiveSettings } from "../rules/datalog/rules-command.js";
import { declaredRulesContext } from "../rules/declared-context.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import { serveArguments } from "./options.js";
import type { ServeReadRuntime } from "./api.js";
import { readServices } from "./services.js";
import { rulesPageHtml, rulesSections, escapeHtml } from "./rules-page.js";
import { compileProjectPolicy } from "../rules/datalog/project/compile.js";

const checkout = resolve("/work/checkout");
const unknown: EffectiveSettings = { status: "unknown", reason: "test: not read" };

const unescape = (html: string) =>
  html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** The sections as the page shows them: each heading and its preformatted text, unescaped. */
function pageSections(html: string): { title: string; lines: string[] }[] {
  return [
    ...html.matchAll(/<section id="section-\d+"><h2>(.*?)<\/h2>\n([\s\S]*?)<\/section>/g),
  ].map((m) => ({
    title: unescape(m[1]!),
    lines: [
      ...m[2]!.matchAll(
        /<pre class="rules">([\s\S]*?)<\/pre>|<p class="formal-introduction">([\s\S]*?)<\/p>|<h3 class="rule-band">([\s\S]*?)<\/h3>/g,
      ),
    ]
      .flatMap((part) => unescape(part[1] ?? part[2] ?? part[3] ?? "").split("\n"))
      .filter((line) => line !== ""),
  }));
}
const formalSections = (text: string) =>
  rulesSections(text).map((s) => ({
    ...s,
    lines: s.lines.filter((line) => line !== ""),
  }));

const page = { origin: "http://127.0.0.1:4372/", served: [], selected: null, filters: {} };

const source = (file: string) => readFileSync(join(policyDir, file), "utf8");
const editedModel = (file: string, edit: (text: string) => string) =>
  compileEnglish(buildPolicy((name) => (name === file ? edit(source(name)) : source(name))));

describe("rules page rendering (#392)", () => {
  it("retains every formal section and line beneath purpose-first controls", () => {
    const doc = rulesDocument({ ...declaredRulesContext(), effective: unknown });
    const text = rulesFormalText(doc);
    const html = rulesPageHtml(doc, text, page);
    expect(pageSections(html)).toEqual(formalSections(text));
    // Nothing is lost by the split: every non-heading line of the text is on the page.
    const lines = text.split("\n").filter((l) => l !== "" && !/^== .+ ==$/.test(l));
    expect(pageSections(html).flatMap((s) => s.lines.filter((l) => l !== ""))).toEqual(lines);
    expect(html).toContain(`<code>${doc.policy.rulesHash}</code>`);
    expect(html).toContain(`<code>${doc.policy.policyVersion}</code>`);
    for (const title of ["Defaults", "Eligibility and denials", "Ordering", "Not formalized here"])
      expect(pageSections(html).map((s) => s.title)).toContain(
        rulesSections(text).find((s) => s.title.startsWith(title))?.title,
      );
  });

  it("changes on the page and in the CLI text together when a compiler fixture changes", () => {
    const before = '[(not= ?role "human")] (eligible ?t) (easy ?t) [1 "order" "impact"]';
    const after = '[(not= ?role "human")] (eligible ?t) (unfavorable ?t) [1 "order" "oldest"]';
    const model = editedModel("decisions.edn", (t) => t.replace(before, after));
    expect(model.rulesHash).not.toBe(shippedModel().rulesHash);
    const doc = rulesDocument({ ...declaredRulesContext(), effective: unknown }, {}, model);
    const text = rulesFormalText(doc);
    const html = rulesPageHtml(doc, text, page);
    expect(pageSections(html)).toEqual(formalSections(text));
    expect(text).toContain("unfavorable(?t)");
    expect(unescape(html)).toContain('the viewer\'s requested order is "oldest"');
    expect(html).toContain(`<code>${model.rulesHash}</code>`);
  });

  it("escapes rule literals instead of interpreting them", () => {
    const model = editedModel("decisions.edn", (t) =>
      t.replace('[1 "order" "impact"]', '[1 "order" "<img src=x onerror=alert(1)>"]'),
    );
    const doc = rulesDocument({ ...declaredRulesContext(), effective: unknown }, {}, model);
    const html = rulesPageHtml(doc, rulesFormalText(doc), page);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.replace('<script src="/project-selection.js" defer></script>', "")).not.toMatch(
      /<img|<script/i,
    );
  });

  it("shows read settings as effective, and otherwise says unknown rather than the defaults", () => {
    const known: EffectiveSettings = {
      status: "known",
      repository: "example/project",
      readFrom: ".github/triage.toml",
      settings: [{ name: "processGuide", value: true, source: "explicit" }],
    };
    const shown = rulesFormalText(rulesDocument({ ...declaredRulesContext(), effective: known }));
    expect(shown).toContain("Effective settings of example/project (read from .github/triage.toml");
    expect(shown).toContain("processGuide = true  (stored in the settings file)");
    const hidden = rulesFormalText(
      rulesDocument({ ...declaredRulesContext(), effective: unknown }),
    );
    expect(hidden).toContain("This repository's effective settings: unknown. test: not read");
    expect(hidden).not.toContain("Effective settings of");
  });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function call(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
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
async function server(args: string[], files: Record<string, string> = {}) {
  const github: string[] = [];
  const record = (name: string) => (): never => {
    github.push(name);
    throw new Error(`${name} must not be called by the rules page`);
  };
  const git: GitRunner = async (gitArgs) =>
    gitArgs[0] === "rev-parse"
      ? `${checkout}\n`
      : "origin\thttps://github.com/example/project.git (fetch)\n";
  const refuse = async (): Promise<never> => {
    throw new Error("the rules page never writes");
  };
  const fs: ConfigFileSystem = {
    readText: async (path) =>
      Object.entries(files).find(([name]) => path === join(checkout, name))?.[1] ?? null,
    writeText: refuse,
    rename: refuse,
    remove: refuse,
    makeDirectory: refuse,
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
    rulesPage: { git, fs },
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

describe("GET /rules (#392)", () => {
  it("renders the selected project's policy and effective settings with no GitHub request", async () => {
    const { running, github, port } = await server(
      ["--project", checkout, "--repo", "other/repo"],
      { ".github/triage.toml": "schemaVersion = 1\nprocessGuide = true\n" },
    );
    try {
      const reply = await call(port, "/rules?repo=example%2Fproject");
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(
        reply.body.replace('<script src="/project-selection.js" defer></script>', ""),
      ).not.toMatch(/<script|\sstyle=|https?:\/\/(?!127\.0\.0\.1)/);
      const text = unescape(reply.body);
      expect(text).toContain("processGuide = true  (stored in the settings file)");
      // #1050: the retired engine selector is not a setting any more.
      expect(text).not.toContain("briefing.engine");
      // Links use the real server origin and encoded selection.
      expect(reply.body).toContain(`href="/rules?repo=other%2Frepo"`);
      expect(reply.body).toContain(`href="/?repo=example%2Fproject"`);

      // A repository served without a project: settings unknown, never the defaults.
      const remote = unescape((await call(port, "/rules?repo=other/repo")).body);
      expect(remote).toContain("This repository's effective settings: unknown.");
      expect(remote).not.toContain("Effective settings of");

      // Several projects and none selected: the selector and the shared policy, settings unknown.
      const none = await call(port, "/rules");
      expect(none.status).toBe(200);
      expect(none.body).toContain("No project selected");
      expect(unescape(none.body)).toContain("effective settings: unknown");

      // A filter is labelled a subset.
      const filtered = await call(port, "/rules?repo=example%2Fproject&role=designer");
      expect(filtered.body).toContain("Filtered subset");
      expect(github).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it("matches pdb rules --json in identity and decisions", async () => {
    const { running, port } = await server(["--repo", "example/project"]);
    try {
      let stdout = "";
      const fail = async () => {
        throw new Error("no network");
      };
      expect(
        await main(["rules", "--json"], async (t) => void (stdout += t), {
          collect: fail,
          currentRepository: fail,
          stderr: () => {},
        }),
      ).toBe(0);
      const cli = JSON.parse(stdout) as ReturnType<typeof rulesDocument>;
      const html = (await call(port, "/rules")).body;
      expect(html).toContain(`<code>${cli.policy.rulesHash}</code>`);
      const decisions = pageSections(html).find((s) => s.title.startsWith("Decision rules"));
      expect(decisions?.title).toBe(`Decision rules (${cli.decisions.length})`);
      for (const d of cli.decisions)
        expect(decisions?.lines.join("\n")).toContain(`${d.id}: action ${d.kind}`);
    } finally {
      await running.close();
    }
  });

  it("refuses unserved, malformed and unknown inputs helpfully, escaping them", async () => {
    const { running, github, port } = await server(["--repo", "example/project"]);
    try {
      const unserved = await call(port, "/rules?repo=evil/repo");
      expect(unserved.status).toBe(403);
      expect(unserved.body).toContain("not served by this server");
      expect(unserved.body).toContain("example/project");
      expect(unserved.body).not.toContain("Decision rules");
      expect((await call(port, "/rules?repo=%3Cscript%3E")).status).toBe(400);
      expect((await call(port, "/rules?other=1")).status).toBe(400);
      const rule = await call(port, "/rules?rule=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
      expect(rule.status).toBe(400);
      expect(rule.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(rule.body).not.toContain("<script>");
      expect(github).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it("applies the Host and Origin guards", async () => {
    const { running, port } = await server(["--repo", "example/project"]);
    try {
      expect((await call(port, "/rules", { host: "evil.example" })).status).toBe(421);
      expect((await call(port, "/rules", { origin: "http://evil.example" })).status).toBe(403);
      expect((await call(port, "/rules", { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    } finally {
      await running.close();
    }
  });
});

describe("purpose-first rule presentation (#578)", () => {
  it("shows sample purposes before closed native formal controls and retains human rules", () => {
    const doc = rulesDocument(declaredRulesContext());
    const html = rulesPageHtml(doc, rulesFormalText(doc), page);
    for (const id of [
      "D-ATTENTION",
      "D-PR-FAIL",
      "D-EASY",
      "D-COMPLEXITY-BOOST",
      "D-INSPECT",
      "D-HUMAN-ASK-YOU",
    ]) {
      const rule = doc.decisions.find((d) => d.id === id)!;
      const start = html.indexOf(`data-rule-id="${id}"`);
      const article = html.slice(start, html.indexOf("</article>", start));
      expect(article.indexOf(escapeHtml(rule.purpose!))).toBeLessThan(article.indexOf("<details"));
      expect(article).toContain(`<summary>Formal conditions for ${id}</summary>`);
      expect(article).not.toMatch(/<details[^>]*\bopen\b/);
    }
    expect(html).toContain("Authored purposes: 51 of 51 rules in this view");
    expect(html).toContain("not evidence that a rule matched a ticket");
    expect(html).toContain("Mutation guards remain outside this listing");
    expect(html).toContain("Not formalized here");
    expect(pageSections(html)).toEqual(formalSections(rulesFormalText(doc)));
  });

  it("keeps missing older metadata and newly introduced rule IDs visible with formal fallback", () => {
    const older = structuredClone(shippedModel());
    for (const rule of [...older.decisions, ...older.denials]) delete rule.purpose;
    const oldDoc = rulesDocument(declaredRulesContext(), {}, older);
    const oldPage = rulesPageHtml(oldDoc, rulesFormalText(oldDoc), page);
    expect(oldPage).toContain("Authored purposes: 0 of 51 rules in this view");
    expect(oldPage).toContain("Purpose not supplied");
    expect(pageSections(oldPage)).toEqual(formalSections(rulesFormalText(oldDoc)));

    const future = editedModel("decisions.edn", (t) =>
      t.replace(':id "D-ATTENTION"', ':id "D-FUTURE"').replace(/\n   :purpose "[^"\n]*"/, ""),
    );
    const doc = rulesDocument(declaredRulesContext(), {}, future);
    const html = rulesPageHtml(doc, rulesFormalText(doc), page);
    expect(doc.narration.missing).toContain("D-FUTURE");
    expect(html).toContain('data-rule-id="D-FUTURE"');
    expect(html).toContain("D-FUTURE: action addressed-response");
    expect(html).toContain("Purpose not supplied");

    const oblDoc = rulesDocument(declaredRulesContext(), { rule: "O-CLAIM-NOOP-CONTINUE" });
    const oblHtml = rulesPageHtml(oblDoc, rulesFormalText(oblDoc), page);
    expect(oblHtml).toContain('data-rule-id="O-CLAIM-NOOP-CONTINUE"');
    expect(oblHtml).toContain("Procedural obligations (1)");
  });

  it("uses metadata from the exact compiled revision and escapes it as literal text", () => {
    const literal =
      "<img src=x onerror=alert(1)> <script>alert(1)</script> & {head} ${secret} https://example.test/";
    const revised = editedModel("decisions.edn", (t) =>
      t.replace(/:purpose "[^"\n]*"/, `:purpose ${JSON.stringify(literal)}`),
    );
    const doc = rulesDocument(declaredRulesContext(), {}, revised);
    const html = rulesPageHtml(doc, rulesFormalText(doc), page);
    expect(revised.rulesHash).toBe(shippedModel().rulesHash);
    expect(revised.narrationHash).not.toBe(shippedModel().narrationHash);
    expect(html).toContain(`<code>${revised.rulesHash}</code>`);
    expect(html).toContain(`<code>${revised.narrationHash}</code>`);
    expect(html).toContain(escapeHtml(literal));
    expect(html.replace('<script src="/project-selection.js" defer></script>', "")).not.toMatch(
      /<img|<script/i,
    );
    expect(html).not.toContain('href="https://example.test/');
    expect(html).not.toContain(escapeHtml(shippedModel().decisions[0].purpose!));
    expect(html).toContain("{head} ${secret}");
  });

  it.each(["implementer", "designer"])(
    "reports purpose coverage for the actual %s filtered view",
    (role) => {
      const doc = rulesDocument(declaredRulesContext(), { role });
      const html = rulesPageHtml(doc, rulesFormalText(doc), { ...page, filters: { role } });
      expect(html).toContain("Filtered subset");
      expect(html).toContain(
        `Authored purposes: ${doc.narration.supplied} of ${doc.narration.total}`,
      );
      expect(doc.narration.total).toBeLessThan(51);
      expect(doc.narration.missing).toEqual([]);
      expect(pageSections(html)).toEqual(formalSections(rulesFormalText(doc)));
    },
  );

  it("carries project-purpose metadata with its own source revision and exposes missing project purposes", () => {
    const model = shippedModel();
    const base = { policyVersion: model.policyVersion, rulesHash: model.rulesHash };
    const fixture = readFileSync(
      new URL("../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
      "utf8",
    ).replace(/:base-rules-hash "[a-f0-9]{64}"/, `:base-rules-hash "${model.rulesHash}"`);
    const policy = compileProjectPolicy(
      fixture
        .replace(":format-version 1", ":format-version 2")
        .replace(":why", ':purpose "Prefer the project priority label." :why'),
      base,
    );
    const doc = rulesDocument({ ...declaredRulesContext(), project: { state: "active", policy } });
    const html = rulesPageHtml(doc, rulesFormalText(doc), page);
    expect(html).toContain("Prefer the project priority label.");
    expect(html).toContain(policy.effectiveRulesHash);
    expect(html).toContain("<dt>Project source format</dt><dd>2 (projection 1)</dd>");
    expect(html).toContain(
      `<dt>Project source revision</dt><dd><code>${policy.projectRulesHash}</code>`,
    );
    expect(doc.project?.preferences[0].purpose).toBe(policy.preferences[0].purpose);
    expect(pageSections(html)).toEqual(formalSections(rulesFormalText(doc)));
    const plain = compileProjectPolicy(fixture, base);
    const missing = rulesDocument({
      ...declaredRulesContext(),
      project: { state: "active", policy: plain },
    });
    expect(missing.narration.missing).toContain(plain.preferences[0].id);
    expect(rulesPageHtml(missing, rulesFormalText(missing), page)).toContain(
      "Purpose not supplied",
    );
  });
});
