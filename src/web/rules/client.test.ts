/**
 * The Rules page client and states (#853): parsing of `/api/v1/rules`, errors as text, and
 * project/role changes that never show a superseded response. Injected fetch; no server.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { rulesDocument, rulesFormalText } from "../../rules/datalog/rules-command.js";
import { declaredRulesContext } from "../../rules/declared-context.js";
import { rulesView } from "../../serve/rules-page.js";
import { fetchRules, parseRulesResponse, rulesLoader } from "./client.js";
import type { RulesState as State } from "./client.js";
import RulesState from "./RulesState.svelte";

const view = (filters: { role?: string } = {}) => {
  const doc = rulesDocument(
    { ...declaredRulesContext(), effective: { status: "unknown", reason: "test" } },
    filters,
  );
  return rulesView(doc, rulesFormalText(doc));
};
const body = (selected: string | null, filters = {}) => ({
  schemaVersion: 1,
  kind: "rules",
  selected,
  filters,
  view: view(filters),
});
const reply = (status: number, json: unknown) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
const html = (state: State) =>
  render(RulesState, { props: { state } }).body.replace(/<!--[\s\S]*?-->/g, "");

describe("rules client (#853)", () => {
  it("reads a rules response and refuses other shapes", async () => {
    const ok = await fetchRules("/api/v1/rules", "?repo=a%2Fb", async (input) => {
      expect(input).toBe("/api/v1/rules?repo=a%2Fb");
      return reply(200, body("a/b"));
    });
    expect(ok.status).toBe("ready");
    expect(parseRulesResponse({ schemaVersion: 2, kind: "rules" })).toBeNull();
    expect(parseRulesResponse("<section>html</section>")).toBeNull();
    const wrong = await fetchRules("/api/v1/rules", "", async () => reply(200, { kind: "other" }));
    expect(wrong).toMatchObject({ status: "error" });
  });

  it("reports the API's error envelope and network failures as errors, never as rules", async () => {
    const refused = await fetchRules("/api/v1/rules", "?repo=evil/x", async () =>
      reply(403, {
        error: { code: "REPOSITORY_NOT_SERVED", message: "That repository is not served." },
      }),
    );
    expect(refused).toEqual({
      status: "error",
      code: "REPOSITORY_NOT_SERVED",
      message: "That repository is not served.",
    });
    const down = await fetchRules("/api/v1/rules", "", async () => {
      throw new TypeError("network");
    });
    expect(down).toMatchObject({ status: "error", code: null });
  });

  it("shows only the newest query's result when an older response arrives late", async () => {
    const pending = new Map<string, (r: Response) => void>();
    const fetcher = (input: RequestInfo | URL) =>
      new Promise<Response>((done) => pending.set(String(input), done));
    const states: State[] = [];
    const loader = rulesLoader("/api/v1/rules", fetcher as typeof fetch, (s) => states.push(s));
    const first = loader.load("?repo=old%2Frepo");
    const second = loader.load("?repo=new%2Frepo");
    // The newer read answers first, then the older one arrives late.
    pending.get("/api/v1/rules?repo=new%2Frepo")!(reply(200, body("new/repo")));
    await second;
    pending.get("/api/v1/rules?repo=old%2Frepo")!(reply(200, body("old/repo")));
    await first;
    const shown = states.filter((s) => s.status === "ready");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.status === "ready" && shown[0]!.response.selected).toBe("new/repo");
    expect(states.at(-1)).toMatchObject({ status: "ready" });
  });
});

describe("rules loader history (#1138 review)", () => {
  it("does not reload or reset the page when only the fragment changes", async () => {
    const calls: string[] = [];
    const states: State[] = [];
    const loader = rulesLoader(
      "/api/v1/rules",
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return reply(200, body("a/b"));
      }) as typeof fetch,
      (s) => states.push(s),
    );
    await loader.load("?repo=a%2Fb");
    // Back/Forward between #section links: the same query again.
    await loader.load("?repo=a%2Fb");
    expect(calls).toEqual(["/api/v1/rules?repo=a%2Fb"]);
    expect(states.map((s) => s.status)).toEqual(["loading", "ready"]);
    // A real query change still reloads.
    await loader.load("?repo=a%2Fb&role=designer");
    expect(calls).toHaveLength(2);
  });
});

describe("rules page states (#853)", () => {
  it("renders loading, error and empty states, escaping error text", () => {
    expect(html({ status: "loading" })).toContain('role="status">Loading the rules…');
    const error = html({ status: "error", code: null, message: "<img src=x onerror=alert(1)>" });
    expect(error).toContain('role="alert">&lt;img src=x onerror=alert(1)>');
    expect(error).not.toContain("<img");
    expect(error).toContain("pdb rules");
    const empty = html({
      status: "empty",
      response: { ...body("a/b"), view: { ...view(), sections: [] } } as never,
    });
    expect(empty).toContain("No rules match this view.");
    expect(empty).toContain('href="/rules?repo=a%2Fb"');
  });

  it("renders a ready view English first, with formal details closed and keyboard-reachable", () => {
    const ready = html({ status: "ready", response: body(null) as never });
    const start = ready.indexOf('data-rule-id="D-ATTENTION"');
    const article = ready.slice(start, ready.indexOf("</article>", start));
    expect(article.indexOf("<p>")).toBeLessThan(article.indexOf("<details"));
    expect(article).toMatch(
      /<details class="rule-formal"><summary>Formal conditions for D-ATTENTION<\/summary>/,
    );
    expect(article).not.toMatch(/<details[^>]*\bopen\b/);
    expect(ready).toContain('<nav aria-label="Sections">');
  });
});
