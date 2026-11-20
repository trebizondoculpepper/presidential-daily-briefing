/**
 * Work preview client (#753, doc/design/svelte-work-spike.md): parsing, stable identity, open
 * rows across refresh, late responses and context isolation, with an injected transport.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  detailLoader,
  expansionController,
  type ExpansionState,
  focusAfter,
  parseTicketDetail,
  parseWorkQueue,
  queueLoader,
  queueUrl,
  reconcileOpen,
  selectedContext,
  type QueueState,
  type WorkContext,
} from "./client.js";

const repo = "example/project";
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const action = (n: number, kind = "implement") => ({
  id: `${repo} ${url(n)} ${kind}`,
  kind,
  target: url(n),
  ruleIds: ["D-ORDINARY"],
  reasonCodes: ["ordinary"],
  why: { text: `Why ${n}` },
  nextCommand: `pdb claim ${n}`,
  impact: { size: "M" },
  complexity: { size: "S" },
});
const envelope = (actions: ReturnType<typeof action>[], extra: Record<string, unknown> = {}) => ({
  status: "complete",
  selection: { repository: repo },
  warnings: [],
  freshness: { source: "live", observedAt: "2026-11-20T10:00:00Z", ageSeconds: 0, stale: false },
  result: {
    repository: repo,
    rankedActions: { total: actions.length + 2, omitted: 2, items: actions },
    // The real API shape: CompactSubject[] (src/briefing/compact.ts), not an object by URL.
    subjects: actions.map((a) => ({
      url: a.target,
      number: Number(a.target.slice(a.target.lastIndexOf("/") + 1)),
      title: `Ticket ${a.target.slice(-1)}`,
      owners: ["agent:kavya"],
      labels: ["status:ready"],
    })),
  },
  ...extra,
});
const ctx = (over: Partial<WorkContext> = {}): WorkContext => ({
  repository: repo,
  role: "implementer",
  agent: "kavya",
  ...over,
});

/** A transport whose responses resolve when the test says so, in any order. */
function deferredFetch() {
  const pending: { url: string; resolve: (body: unknown) => void; signal?: AbortSignal | null }[] =
    [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({
        url: String(input),
        signal: init?.signal,
        resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
      });
    })) as typeof fetch;
  return { fetcher, pending };
}

describe("work preview: parsing (#753)", () => {
  it("keeps the supplied order and counts, keyed by repository plus action ID", () => {
    const q = parseWorkQueue(envelope([action(3), action(1), action(2)]))!;
    expect(q.rows.map((r) => r.number)).toEqual([3, 1, 2]);
    expect(q.rows[0]!.key).toBe(`${repo} ${repo} ${url(3)} implement`);
    expect(q).toMatchObject({ shown: 3, total: 5, omitted: 2, status: "complete" });
    expect(q.rows[0]).toMatchObject({
      title: "Ticket 3",
      why: "Why 3",
      impact: "M",
      complexity: "S",
    });
    expect(parseWorkQueue({ result: {} })).toBeNull();
    expect(parseWorkQueue(envelope([{ ...action(1), id: undefined } as never]))).toBeNull();
  });

  it("parses the ticket-status detail, and rejects anything else", () => {
    const detail = parseTicketDetail({
      warnings: ["w"],
      result: {
        kind: "ticket-status",
        title: "T",
        state: "OPEN",
        url: url(1),
        ownership: { answer: "recorded claim: kavya" },
        delivery: { verdict: "no-record" },
        pullRequests: [{ number: 9, url: "https://github.com/example/project/pull/9" }],
        nextSteps: [{ kind: "follow-up", why: "Review", command: "pdb pr 9" }],
        completeness: { complete: false, warnings: ["partial"] },
      },
    })!;
    expect(detail).toMatchObject({ ownership: "recorded claim: kavya", complete: false });
    expect(detail.warnings).toEqual(["partial", "w"]);
    expect(parseTicketDetail({ result: { kind: "other" } })).toBeNull();
  });

  it("validates the URL selection and builds the scoped request", () => {
    expect(selectedContext("?repo=example/project&role=designer&agent=kavya")).toEqual(
      ctx({ role: "designer" }),
    );
    expect(selectedContext("?repo=bad")).toBeNull();
    expect(selectedContext("?repo=example/project&agent=<x>")).toMatchObject({ agent: null });
    expect(queueUrl("/api/v1/briefing", ctx(), true)).toBe(
      "/api/v1/briefing?repo=example%2Fproject&role=implementer&agent=kavya&refresh=true",
    );
  });
});

describe("work preview: open rows and focus across refresh (#753)", () => {
  const rows = (...ns: [number, string?][]) =>
    parseWorkQueue(envelope(ns.map(([n, k]) => action(n, k))))!.rows;

  it("keeps open rows by identity when reordered, and drops removed ones", () => {
    const before = rows([1], [2], [3]);
    const open = new Set([before[0]!.key, before[2]!.key]);
    const after = rows([3], [1]);
    expect([...reconcileOpen(open, after)].sort()).toEqual([before[0]!.key, before[2]!.key].sort());
    expect([...reconcileOpen(open, rows([2]))]).toEqual([]);
  });

  it("never lets a different action on the same issue inherit an open row", () => {
    const open = new Set([rows([1, "implement"])[0]!.key]);
    expect([...reconcileOpen(open, rows([1, "estimate-complexity"]))]).toEqual([]);
  });

  it("moves focus to the nearest surviving row when the focused one disappears", () => {
    const before = rows([1], [2], [3]);
    expect(focusAfter(before[1]!.key, before, rows([3], [2]))).toBe(before[1]!.key);
    expect(focusAfter(before[1]!.key, before, rows([1], [3]))).toBe(before[2]!.key);
    expect(focusAfter(before[1]!.key, before, rows())).toBeNull();
  });
});

describe("work preview: loading states, late responses and contexts (#753)", () => {
  it("shows loading first, then keeps the earlier list as updating during a refresh", async () => {
    const t = deferredFetch();
    const states: QueueState[] = [];
    const loader = queueLoader("/api", t.fetcher, (s) => void states.push(s));
    const first = loader.load(ctx());
    expect(states.at(-1)).toEqual({ status: "loading" });
    t.pending[0]!.resolve(envelope([action(1)]));
    await first;
    const again = loader.refresh();
    expect(states.at(-1)).toMatchObject({ status: "ready", updating: true });
    expect(t.pending[1]!.url).toContain("refresh=true");
    t.pending[1]!.resolve(envelope([action(2)]));
    await again;
    expect(states.at(-1)).toMatchObject({ status: "ready", updating: false });
  });

  it("discards a late response from an older read or another context", async () => {
    const t = deferredFetch();
    const states: [QueueState, WorkContext | null][] = [];
    const loader = queueLoader("/api", t.fetcher, (s, c) => void states.push([s, c]));
    const old = loader.load(ctx());
    const fresh = loader.load(ctx({ agent: "dario" }));
    // The newer context's read starts from loading, never from the other context's list.
    expect(states.at(-1)![0]).toEqual({ status: "loading" });
    t.pending[1]!.resolve(envelope([action(2)]));
    await fresh;
    t.pending[0]!.resolve(envelope([action(1)]));
    expect(await old).toBeNull();
    const last = states.at(-1)!;
    expect(last[1]).toMatchObject({ agent: "dario" });
    expect(last[0].status === "ready" && last[0].queue.rows.map((r) => r.number)).toEqual([2]);
  });

  it("keeps the earlier list on a failed refresh and reports the error distinctly", async () => {
    const states: QueueState[] = [];
    let call = 0;
    const fetcher = (async () =>
      ++call === 1
        ? new Response(JSON.stringify(envelope([action(1)])), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Slow down." } }), {
            status: 429,
          })) as typeof fetch;
    const loader = queueLoader("/api", fetcher, (s) => void states.push(s));
    await loader.load(ctx());
    await loader.refresh();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      code: "RATE_LIMITED",
      message: "Slow down.",
      previous: { shown: 1 },
    });
  });

  it("loads details on demand, coalesces the same ticket, and never leaks across contexts", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      return new Response(
        JSON.stringify({
          result: { kind: "ticket-status", title: "T", state: "OPEN", url: url(1) },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const d = detailLoader("/api/v1/tickets", fetcher);
    const [a, b] = await Promise.all([d.load(ctx(), 1), d.load(ctx(), 1)]);
    expect(requests).toBe(1);
    expect(a).toEqual(b);
    const generation = d.generation();
    expect(d.current(ctx(), generation)).toBe(true);
    await d.load(ctx({ role: "designer" }), 1);
    expect(requests).toBe(2);
    expect(d.current(ctx(), generation)).toBe(false);
  });

  it("discards details from before a same-context refresh and reads them again (#1164 review)", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      return new Response(
        JSON.stringify({
          result: { kind: "ticket-status", title: "T", state: "OPEN", url: url(1) },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const d = detailLoader("/api/v1/tickets", fetcher);
    const before = d.generation();
    await d.load(ctx(), 1);
    d.invalidate();
    // A result loaded before the refresh is no longer current, and the next load reads again.
    expect(d.current(ctx(), before)).toBe(false);
    await d.load(ctx(), 1);
    expect(requests).toBe(2);
    expect(d.current(ctx(), d.generation())).toBe(true);
  });
});

describe("work preview: expansion controller (#1164 review)", () => {
  const rowsOf = (...ns: number[]) => parseWorkQueue(envelope(ns.map((n) => action(n))))!.rows;
  const ticket = (n: number) =>
    new Response(
      JSON.stringify({
        status: "complete",
        result: { kind: "ticket-status", title: `T${n}`, state: "OPEN", url: url(n) },
      }),
      { status: 200 },
    );

  it("opens rows at once, keeps several open while details are pending, and loads each", async () => {
    const t = deferredFetch();
    const states: ExpansionState[] = [];
    const c = expansionController(
      detailLoader("/api/v1/tickets", t.fetcher),
      (s) => void states.push(s),
    );
    c.setContext(ctx());
    const [a, b] = rowsOf(1, 2);
    const pa = c.toggle(a!);
    const pb = c.toggle(b!);
    // Both open immediately, both loading, neither overwrote the other.
    expect([...states.at(-1)!.open].sort()).toEqual([a!.key, b!.key].sort());
    expect(states.at(-1)!.details[a!.key]).toEqual({ status: "loading" });
    t.pending[1]!.resolve({
      status: "complete",
      result: { kind: "ticket-status", title: "T2", state: "OPEN", url: url(2) },
    });
    t.pending[0]!.resolve({
      status: "complete",
      result: { kind: "ticket-status", title: "T1", state: "OPEN", url: url(1) },
    });
    await Promise.all([pa, pb]);
    const last = states.at(-1)!;
    expect(last.open.size).toBe(2);
    expect(last.details[a!.key]).toMatchObject({ status: "ready", detail: { title: "T1" } });
    expect(last.details[b!.key]).toMatchObject({ status: "ready", detail: { title: "T2" } });
  });

  it("ignores a detail that arrives after its row was collapsed", async () => {
    const t = deferredFetch();
    const states: ExpansionState[] = [];
    const c = expansionController(
      detailLoader("/api/v1/tickets", t.fetcher),
      (s) => void states.push(s),
    );
    c.setContext(ctx());
    const [a] = rowsOf(1);
    const pending = c.toggle(a!);
    await c.toggle(a!);
    t.pending[0]!.resolve({
      status: "complete",
      result: { kind: "ticket-status", title: "T1", state: "OPEN", url: url(1) },
    });
    await pending;
    expect(states.at(-1)!.open.size).toBe(0);
    expect(states.at(-1)!.details[a!.key]).not.toMatchObject({ status: "ready" });
  });

  it("never reads a ticket detail for a pull-request row", async () => {
    let requests = 0;
    const fetcher = (async () => (requests++, ticket(1))) as typeof fetch;
    const c = expansionController(detailLoader("/api/v1/tickets", fetcher), () => {});
    c.setContext(ctx());
    const prRow = {
      ...rowsOf(1)[0]!,
      target: `https://github.com/${repo}/pull/7`,
      number: 7,
      subjectKind: "pr" as const,
    };
    await c.toggle(prRow);
    expect(requests).toBe(0);
  });

  it("keeps surviving open rows across a refresh and re-reads their details; a context change closes all", async () => {
    let requests = 0;
    const fetcher = (async (u: RequestInfo | URL) => {
      requests++;
      return ticket(Number(/\/(\d+)\?/.exec(String(u))![1]));
    }) as typeof fetch;
    const states: ExpansionState[] = [];
    const c = expansionController(
      detailLoader("/api/v1/tickets", fetcher),
      (s) => void states.push(s),
    );
    c.setContext(ctx());
    const [a, b] = rowsOf(1, 2);
    await c.toggle(a!);
    await c.toggle(b!);
    expect(requests).toBe(2);
    await c.refreshed(rowsOf(2, 3));
    expect([...states.at(-1)!.open]).toEqual([b!.key]);
    expect(requests).toBe(3);
    expect(states.at(-1)!.details[b!.key]).toMatchObject({ status: "ready" });
    c.setContext(ctx({ agent: "dario" }));
    expect(states.at(-1)!.open.size).toBe(0);
  });
});

describe("work preview: coverage and staleness (#1164 review)", () => {
  it("shows the report's own coverage warnings with the envelope's", () => {
    const body = envelope([action(1)], { warnings: ["envelope"] }) as Record<string, unknown>;
    (body.result as Record<string, unknown>).completeness = {
      complete: false,
      warnings: ["report"],
    };
    expect(parseWorkQueue(body)!.warnings).toEqual(["report", "envelope"]);
  });

  it("marks a retained, stale or incomplete detail envelope as such", () => {
    const detail = parseTicketDetail({
      status: "incomplete",
      freshness: { stale: true },
      result: {
        kind: "ticket-status",
        title: "T",
        state: "OPEN",
        url: url(1),
        completeness: { complete: true, warnings: [] },
      },
    })!;
    expect(detail).toMatchObject({ complete: false, stale: true });
  });

  it("classifies the row's subject from its target", () => {
    const row = parseWorkQueue(
      envelope([{ ...action(1), target: `https://github.com/${repo}/pull/7` }]),
    )!.rows[0]!;
    expect(row.subjectKind).toBe("pr");
  });
});
