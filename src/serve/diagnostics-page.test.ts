import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { diagnosticsPage, diagnosticsScript, diagnosticRenderers } from "./diagnostics-page.js";
import { dashboardRenderers } from "./dashboard.js";

const repo = "example/project",
  at = "2026-11-17T00:00:00.000Z";
const served = [{ repository: repo }, { repository: "example/other" }];
const native = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "diagnostic-run",
  runId: "run-one",
  waiterId: "waiter-one",
  run: "doctor",
  context: { host: "github.com", login: "reader", repository: repo },
  state: "running",
  startedAt: at,
  finishedAt: null,
  progress: [{ step: "gh", state: "running", detail: "Observed check started" }],
  result: null,
  error: null,
  ...extra,
});
const local = {
  schemaVersion: 1,
  scope: "local-configuration",
  checks: [
    {
      id: "gh.available",
      status: "missing",
      source: "gh probe",
      detail: "Install the GitHub CLI.",
      next: ["gh --version"],
    },
  ],
};
const ticket = {
  schemaVersion: 1,
  kind: "ticket-doctor",
  repository: repo,
  fetchedAt: at,
  freshness: { offline: false },
  scanned: 1,
  summary: { tickets: 1, definite: 1, candidate: 0, unknown: 0 },
  omittedTickets: 2,
  completeness: { complete: false, warnings: ["Native evidence unavailable"] },
  guidance: "Read-only suggestions.",
  tickets: [
    {
      number: 1,
      title: "Ticket <script>bad()</script>",
      url: `https://github.com/${repo}/issues/1`,
      findings: [
        {
          kind: "readiness-conflict",
          certainty: "definite",
          detail: "Conflicting labels <img src=x>",
          plan: {
            judgment: true,
            facts: ["Two labels observed"],
            steps: [
              {
                kind: "inspect",
                description: "Inspect before choosing",
                command: "pdb ticket 1 --repo example/project",
                runBy: "claimant",
                choice: "inspect",
                preconditions: ["Only after confirming the intended state"],
              },
            ],
          },
        },
      ],
    },
  ],
};

describe("Diagnostics page and native report projection (#585)", () => {
  it("has an explicit global Doctor and project-required Ticket Doctor without inline code", () => {
    const doctor = diagnosticsPage(new URLSearchParams(), served);
    expect(doctor.status).toBe(200);
    expect(doctor.html).toContain("Server machine: checks run where pdb serve runs");
    expect(doctor.html).toContain('role="tablist"');
    expect(doctor.html).toContain('aria-selected="true"');
    expect(doctor.html).toContain('<script src="/diagnostics.js"');
    expect(doctor.html).not.toMatch(/<script>|\bonclick=|<style/);
    const noProject = diagnosticsPage(new URLSearchParams({ tab: "ticket-doctor" }), served);
    expect(noProject.html).toContain("Select a project above");
    expect(noProject.html).toMatch(/id="diagnostic-run"[^>]*disabled/);
    expect(
      diagnosticsPage(new URLSearchParams({ repo, tab: "ticket-doctor" }), served).html,
    ).not.toMatch(/id="diagnostic-run"[^>]*disabled/);
    expect(diagnosticsPage(new URLSearchParams({ tab: "other" }), served).status).toBe(400);
    expect(diagnosticsPage(new URLSearchParams({ repo: "unserved/project" }), served).status).toBe(
      403,
    );
    expect(diagnosticsPage(new URLSearchParams({ path: "/private" }), served).status).toBe(400);
  });
  it("keeps status, timestamps, native findings and exact suggested commands without executing prose", () => {
    const view = diagnosticRenderers(dashboardRenderers());
    const check = view.render(native({ state: "completed", finishedAt: at, result: local }), true);
    expect(check.state).toContain("retained result, not a new reading");
    expect(check.state).toContain(at);
    expect(check.result).toContain("gh.available · missing");
    expect(check.result).toContain("gh --version");
    const finding = view.render(
      native({ run: "ticket-doctor", state: "partial", result: ticket }),
      false,
    );
    expect(finding.result).toContain("Incomplete coverage");
    expect(finding.result).toContain("1 definite · 0 candidate · 0 unknown");
    expect(finding.result).toContain('href="/ticket?repo=example%2Fproject&amp;n=1"');
    expect(finding.result).toContain(`href="https://github.com/${repo}/issues/1"`);
    expect(finding.result).toContain("<details");
    expect(finding.result).toContain("Only after confirming");
    expect(finding.result).toContain("pdb ticket 1 --repo example/project");
    expect(finding.result).toContain("2 further tickets omitted");
    expect(finding.result).not.toMatch(/<script|<img|onclick/);
    expect(finding.result).toContain("&lt;script&gt;");
    const malicious = structuredClone(ticket);
    malicious.tickets[0].url = "javascript:alert(1)";
    expect(view.render(native({ result: malicious }), false).result).not.toContain(
      'href="javascript:',
    );
    expect(
      view.render(
        native({ run: "ticket-doctor", result: { ...ticket, repository: "another/project" } }),
        false,
      ).result,
    ).toContain("not shown");
  });
  it("preserves empty/unknown coverage and safe error text without inventing a healthy result", () => {
    const view = diagnosticRenderers(dashboardRenderers());
    expect(view.render({ state: "none" }, true).state).toContain("No retained run");
    const empty = view.render(
      native({
        run: "ticket-doctor",
        state: "partial",
        result: { ...ticket, tickets: [], summary: {} },
      }),
      false,
    );
    expect(empty.result).toContain("unknown tickets with findings");
    expect(empty.result).toContain("available evidence");
    expect(empty.result).not.toContain("healthy");
    const failed = view.render(
      native({
        state: "failed",
        error: { code: "RUN_TIMEOUT", message: "<img>", next: ["pdb doctor"] },
      }),
      false,
    );
    expect(failed.state).toContain("RUN_TIMEOUT");
    expect(failed.state).not.toContain("<img>");
    expect(failed.result).toBe("");
    expect(() => new Script(diagnosticsScript())).not.toThrow();
  });
});

class Element {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: Event) => void)[]>();
  hidden = false;
  disabled = false;
  tabIndex = 0;
  value = "";
  href = "";
  private html = "";
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
  }
  get textContent() {
    return this.html;
  }
  set textContent(value: string) {
    this.html = value;
  }
  focus = () => {
    this.focused();
  };
  constructor(private readonly focused: () => void = () => undefined) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, handler: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  emit(name: string, event = new Event(name)) {
    if (name === "click" && this.disabled) return;
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
}
function browser(selected = repo, tab = "doctor") {
  let active: Element | null = null;
  const elements = new Map<string, Element>();
  for (const id of [
    "content",
    "diagnostic-run",
    "diagnostic-cancel",
    "diagnostic-state",
    "diagnostic-progress",
    "diagnostic-results",
    "diagnostic-live",
    "diagnostic-limit",
    "diagnostic-stale",
    "doctor-tab",
    "ticket-doctor-tab",
    "diagnostic-panel",
    "diagnostic-options",
    "diagnostic-title",
    "diagnostic-scope",
  ]) {
    let element: Element;
    element = new Element(() => {
      active = element;
    });
    elements.set(id, element);
  }
  const root = elements.get("content")!;
  root.dataset = { diagnosticRepo: selected, diagnosticTab: tab };
  elements.get("diagnostic-limit")!.value = "30";
  elements.get("diagnostic-stale")!.value = "24";
  const events = new Map<string, (event: Event) => void>(),
    timers = new Map<number, { fn: () => void; ms: number }>();
  const requests: {
    path: string;
    init: RequestInit;
    resolve: (response: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let timerId = 0,
    reloads = 0;
  const location = {
    href: `http://localhost/diagnostics?${new URLSearchParams({ ...(selected ? { repo: selected } : {}), tab })}`,
    reload: () => {
      reloads++;
    },
  };
  const carried = [new Element(), new Element()];
  carried[0].href = "/diagnostics?repo=example%2Fother";
  carried[1].href = "/diagnostics";
  const window = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: URL | string) => {
        location.href = String(url);
      },
    },
    addEventListener: (name: string, listener: (event: Event) => void) =>
      events.set(name, listener),
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(diagnosticsScript(), {
    window,
    document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => carried },
    URL,
    URLSearchParams,
    Headers,
    AbortController,
    fetch: (path: string, init: RequestInit = {}) =>
      new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })),
  });
  return {
    elements,
    carried,
    events,
    timers,
    requests,
    location,
    active: () => active,
    reloads: () => reloads,
    click: (id: string) => elements.get(id)!.emit("click"),
    posted: (n: number) => {
      const body = requests[n].init.body;
      if (typeof body !== "string") throw new Error("Expected JSON request text");
      return JSON.parse(body);
    },
    respond: (n: number, body: unknown, status = 200) =>
      requests[n].resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
    fire: () => {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.fn();
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Diagnostics browser controller (#585)", () => {
  it("looks up retained state once, runs only on request, and polls only its own running waiter", async () => {
    const b = browser();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0].path).toContain("/latest?");
    expect(b.timers.size).toBe(0);
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    expect(b.requests[1].init.method).toBe("POST");
    expect(b.posted(1)).toEqual({
      kind: "doctor",
      repo,
      options: {},
    });
    b.respond(1, native());
    await settle();
    expect(b.requests[2].path).toContain("waiters/waiter-one");
    b.respond(2, native());
    await settle();
    expect(b.timers.size).toBe(1);
    expect([...b.timers.values()][0].ms).toBe(500);
    b.fire();
    b.respond(3, native({ state: "completed", finishedAt: at, result: local }));
    await settle();
    expect(b.timers.size).toBe(0);
    expect(b.elements.get("diagnostic-results")!.innerHTML).toContain("gh.available");
    expect(b.elements.get("diagnostic-cancel")!.hidden).toBe(true);
    expect(b.elements.get("diagnostic-run")!.disabled).toBe(false);
  });
  it("does not subscribe to a retained running execution until Run explicitly joins it", async () => {
    const b = browser();
    b.respond(0, native({ waiterId: undefined }));
    await settle();
    expect(b.requests).toHaveLength(1);
    expect(b.timers.size).toBe(0);
    expect(b.elements.get("diagnostic-run")!.textContent).toBe("Join run");
    expect(b.elements.get("diagnostic-cancel")!.hidden).toBe(true);
    b.click("diagnostic-run");
    expect(b.requests[1].init.method).toBe("POST");
  });
  it("cancels only its own subscription and displays the observed terminal status", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.respond(1, native());
    await settle();
    b.respond(2, native());
    await settle();
    b.click("diagnostic-cancel");
    expect(b.timers.size).toBe(0);
    expect(b.requests[3].init.method).toBe("DELETE");
    b.respond(3, null, 204);
    await settle();
    b.respond(4, native({ state: "cancelled", finishedAt: at }));
    await settle();
    expect(b.elements.get("diagnostic-state")!.innerHTML).toContain("Run cancelled");
    expect(b.elements.get("diagnostic-cancel")!.hidden).toBe(true);
  });
  it("offers a status retry when cancellation cannot be confirmed, without creating a new waiter", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.respond(1, native());
    await settle();
    b.respond(2, native());
    await settle();
    b.click("diagnostic-cancel");
    b.requests[3].reject(new Error("PRIVATE NETWORK ERROR"));
    await settle();
    expect(b.elements.get("diagnostic-state")!.innerHTML).toContain(
      "Cancellation was not confirmed",
    );
    expect(b.elements.get("diagnostic-state")!.innerHTML).not.toContain("PRIVATE");
    b.click("diagnostic-run");
    expect(b.requests[4].init.method ?? "GET").toBe("GET");
    expect(b.requests.filter((r) => r.init.method === "POST")).toHaveLength(1);
  });
  it("discards a superseded response and releases a late POST handle when tabs change", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.click("ticket-doctor-tab");
    expect(b.requests[2].path).toContain("kind=ticket-doctor");
    b.respond(
      1,
      native({
        state: "completed",
        result: { ...local, checks: [{ detail: "OLD PROJECT RESULT" }] },
      }),
    );
    await settle();
    expect(b.requests[3].init.method).toBe("DELETE");
    expect(b.requests[3].init.keepalive).toBe(true);
    b.respond(3, null, 204);
    b.respond(2, { state: "none" });
    await settle();
    expect(b.elements.get("diagnostic-results")!.innerHTML).not.toContain("OLD PROJECT RESULT");
    expect(b.timers.size).toBe(0);
  });
  it("supports keyboard tabs, project-required scans and normalized numeric options", async () => {
    const noProject = browser("", "ticket-doctor");
    expect(noProject.requests).toHaveLength(0);
    expect(noProject.elements.get("diagnostic-run")!.disabled).toBe(true);
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.elements
      .get("doctor-tab")!
      .emit("keydown", Object.assign(new Event("keydown"), { key: "ArrowRight" }));
    expect(b.active()).toBe(b.elements.get("ticket-doctor-tab"));
    expect(b.elements.get("ticket-doctor-tab")!.attributes.get("aria-selected")).toBe("true");
    expect(b.location.href).toContain("tab=ticket-doctor");
    expect(b.carried[0].href).toContain("repo=example%2Fother&tab=ticket-doctor");
    expect(b.carried[1].href).toBe("/diagnostics?tab=ticket-doctor");
    b.respond(1, { state: "none" });
    await settle();
    b.elements.get("diagnostic-limit")!.value = "7";
    b.elements.get("diagnostic-limit")!.emit("change");
    expect(b.requests[2].path).toContain("limit=7");
    b.respond(2, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    expect(b.posted(3)).toEqual({
      kind: "ticket-doctor",
      repo,
      options: { limit: 7, staleHours: 24 },
    });
  });
  it("cancels on navigation, reloads changed project context and never renders the old answer", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.respond(1, native());
    await settle();
    b.location.href = "http://localhost/diagnostics?repo=example%2Fother";
    b.events.get("popstate")!(new Event("popstate"));
    expect(b.reloads()).toBe(1);
    expect(b.requests[3].init.method).toBe("DELETE");
    expect(b.requests[3].init.keepalive).toBe(true);
    b.respond(2, native({ state: "completed", result: { ...local, checks: [{ detail: "OLD" }] } }));
    await settle();
    expect(b.elements.get("diagnostic-results")!.innerHTML).not.toContain("OLD");
    expect(b.timers.size).toBe(0);
  });
  it("rejects foreign contexts and escapes server errors instead of showing their result", async () => {
    const b = browser();
    b.respond(
      0,
      native({
        context: { host: "github.com", login: "reader", repository: "foreign/project" },
        result: local,
      }),
    );
    await settle();
    expect(b.elements.get("diagnostic-state")!.innerHTML).toContain("different diagnostic context");
    expect(b.elements.get("diagnostic-results")!.innerHTML).toBe("");
    b.click("diagnostic-run");
    b.respond(1, { error: { code: "FAIL", message: "<img src=x>" } }, 500);
    await settle();
    expect(b.elements.get("diagnostic-state")!.innerHTML).toContain("&lt;img");
    expect(b.elements.get("diagnostic-state")!.innerHTML).not.toContain("<img");
  });
  it("releases an expired waiter and offers a new Run instead of an endless status retry", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.respond(1, native());
    await settle();
    b.respond(2, { error: { code: "NOT_FOUND", message: "The waiter expired." } }, 404);
    await settle();
    expect(b.elements.get("diagnostic-run")!.textContent).toBe("Run again");
    expect(b.elements.get("diagnostic-cancel")!.hidden).toBe(true);
    b.click("diagnostic-run");
    expect(b.requests[3].init.method).toBe("POST");
  });
  it("does not release a foreign handle from a malformed late POST response", async () => {
    const b = browser();
    b.respond(0, { state: "none" });
    await settle();
    b.click("diagnostic-run");
    b.click("ticket-doctor-tab");
    b.respond(
      1,
      native({ context: { host: "github.com", login: "reader", repository: "foreign/project" } }),
    );
    await settle();
    expect(b.requests.filter((r) => r.init.method === "DELETE")).toHaveLength(0);
  });
});

describe("Diagnostics page HTTP shell (#585)", () => {
  it("serves guarded HTML/script without starting a diagnostic or fetching repository evidence", async () => {
    const { EventEmitter } = await import("node:events");
    const { startServe } = await import("../serve.js");
    const { serveArguments } = await import("./options.js");
    let auth = 0,
      dataRoutes = 0;
    const running = await startServe(
      serveArguments(["--port", "0", "--repo", repo]),
      {
        currentRepository: async () => repo,
        authContext: async () => {
          auth++;
          return { host: "github.com", login: "reader" };
        },
        clock: {
          now: () => new Date(at),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        },
        stdout: () => undefined,
        stderr: () => undefined,
        signals: new EventEmitter(),
        exit: () => undefined,
        version: async () => "1.0.0",
        platform: process.platform,
      },
      () => ({
        routes: async () => {
          dataRoutes++;
          return false;
        },
      }),
    );
    try {
      const page = await fetch(new URL("diagnostics", running.facts.url));
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(html).toContain("Server machine");
      expect(html).not.toMatch(/<script>|\bonclick=/);
      const script = await fetch(new URL("diagnostics.js", running.facts.url));
      expect(script.headers.get("content-type")).toContain("javascript");
      const body = await script.text();
      expect(() => new Script(body)).not.toThrow();
      const head = await fetch(new URL("diagnostics?tab=ticket-doctor", running.facts.url), {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      const selected = await fetch(
        new URL(
          `diagnostics?repo=${encodeURIComponent(repo)}&tab=ticket-doctor`,
          running.facts.url,
        ),
      );
      expect(selected.status).toBe(200);
      expect(await selected.text()).toContain(`data-diagnostic-repo="${repo}"`);
      expect(await head.text()).toBe("");
      expect((await fetch(new URL("diagnostics?tab=invalid", running.facts.url))).status).toBe(400);
      expect(
        (await fetch(new URL("diagnostics", running.facts.url), { method: "POST" })).status,
      ).toBe(405);
      expect(
        (
          await fetch(new URL("diagnostics", running.facts.url), {
            headers: { origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect(auth).toBe(1);
      expect(dataRoutes).toBe(0);
    } finally {
      await running.close();
    }
  });
});
