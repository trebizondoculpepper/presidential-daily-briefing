/** Overview news client (#824): parsing, evidence links, selection and loading. */
import { describe, expect, it } from "vite-plus/test";
import {
  itemLinks,
  kindLabel,
  newsLoader,
  parseNewsResponse,
  selection,
  type NewsState,
} from "./client.js";

const repo = "example/project";
const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  status: "complete",
  warnings: [],
  freshness: { observedAt: "2026-11-20T10:00:00Z", stale: false, source: "live", ageSeconds: 0 },
  result: {
    kind: "pipeline-metrics",
    view: "news",
    window: { from: "2026-11-20T04:00:00.000Z", through: "2026-11-20T10:00:00.000Z" },
    coverage: { historyCompleteFrom: null, note: null },
    items,
    omitted: 0,
    incomplete: { count: 0, members: [] },
    ...extra,
  },
});
const item = (
  kind: string,
  member: string,
  detail: string | null = null,
  at = "2026-11-20T09:00:00Z",
) => ({
  at,
  kind,
  member,
  key: `${kind}:${member}:${at}`,
  detail,
});

describe("overview news (#824)", () => {
  it("keeps the server's order and counts, and rejects anything else", () => {
    const r = parseNewsResponse(
      body(
        [
          item("closed", `${repo}#2`, "COMPLETED", "2026-11-20T09:30:00Z"),
          item("created", `${repo}#3`),
        ],
        {
          omitted: 4,
          incomplete: { count: 1, members: [`${repo}#9`] },
        },
      ),
    )!;
    expect(r.items.map((i) => i.member)).toEqual([`${repo}#2`, `${repo}#3`]);
    expect(r).toMatchObject({ omitted: 4, incomplete: { count: 1 }, freshness: { stale: false } });
    expect(parseNewsResponse({ result: { kind: "pipeline-metrics", view: "daily" } })).toBeNull();
    expect(parseNewsResponse(body([{ at: 1 }]))).toBeNull();
  });

  it("links each item to its ticket, and a merge to its PR; a walked merge has no ticket", () => {
    const merge = itemLinks(item("pr-merged", `${repo}#5`, `${repo}#40`), "?agent=kavya");
    expect(merge.ticket).toEqual({
      label: `${repo}#5`,
      href: "/ticket?repo=example%2Fproject&n=5&agent=kavya",
    });
    expect(merge.pr).toEqual({
      label: `${repo}#40`,
      href: "https://github.com/example/project/pull/40",
    });
    const walked = itemLinks(item("pr-merged", `${repo}#41`, `${repo}#41`), "");
    expect(walked.ticket).toBeNull();
    expect(walked.pr?.href).toBe("https://github.com/example/project/pull/41");
    expect(itemLinks(item("created", `${repo}#3`), "").pr).toBeNull();
    expect(kindLabel("picked-up")).toBe("Picked up");
    expect(kindLabel("future-kind")).toBe("future-kind");
  });

  it("defaults to the 6-hour window, with 1 hour as the alternative", () => {
    expect(selection("?repo=example/project")).toEqual({ repository: repo, hours: 6 });
    expect(selection("?repo=example/project&news=1h")).toEqual({ repository: repo, hours: 1 });
    expect(selection("?repo=bad&news=1h")).toEqual({ repository: null, hours: 1 });
  });

  it("requests the news view, discards a superseded read, and refreshes past the cache", async () => {
    const pending: { url: string; resolve: (b: unknown) => void }[] = [];
    const fetcher = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) =>
        pending.push({
          url: String(input),
          resolve: (b) => resolve(new Response(JSON.stringify(b), { status: 200 })),
        }),
      )) as typeof fetch;
    const states: NewsState[] = [];
    const loader = newsLoader("/api/v1/metrics", fetcher, (s) => void states.push(s));
    const first = loader.load({ repository: repo, hours: 6 });
    const second = loader.load({ repository: repo, hours: 1 });
    expect(pending[0]!.url).toBe("/api/v1/metrics?view=news&repo=example%2Fproject&hours=6");
    pending[1]!.resolve(body([item("created", `${repo}#1`)]));
    await second;
    pending[0]!.resolve(body([]));
    expect(await first).toBeNull();
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      response: { items: [{ member: `${repo}#1` }] },
    });
    void loader.refresh();
    expect(pending[2]!.url).toContain("hours=1&refresh=true");
  });
});
