/** Whole discovery facts are shared; selected discussion and rendering are not. */
import { describe, expect, it } from "vite-plus/test";
import { cachedBoundaries } from "./api.js";
import { ServeCache } from "./cache.js";
import type { ShortlistBounds } from "../github/shortlist.js";
import { collectShortlist } from "../github/shortlist.js";
import { dependencyReport, RateLimitError } from "../github/dependencies.js";
import type { Query } from "../github/github.js";
import { issue, page, repo, time } from "../testing/snapshots.js";
import type { Clock } from "../mcp/polling.js";

function setup(
  discoveryGate?: Promise<void>,
  hydrationGate?: Promise<void>,
  hydrationStarted?: () => void,
) {
  let partial = false;
  let refuseHydration = false;
  let refusals = 0;
  let active = 0;
  let peak = 0;
  let stamp = Date.parse(time);
  const clock: Clock = {
    now: () => new Date(stamp),
    setTimeout: () => ({}),
    clearTimeout: () => {},
  };
  const calls = { discovery: 0, hydrated: [] as number[], full: 0 };
  const issues = [issue(1), issue(2), issue(3)];
  const query: Query = async (source, variables) => {
    if (source.includes("issues(first:")) {
      expect(source).not.toMatch(/comments\(|body|reviewThreads/);
      calls.discovery++;
      await discoveryGate;
      return {
        repository: {
          issues: page(
            issues.map((item) => {
              const { body: _b, comments: _c, ...basic } = item;
              return structuredClone(basic);
            }),
            partial,
            partial ? "next" : null,
          ),
        },
      };
    }
    if (source.includes("pullRequests(first:")) {
      expect(source).not.toMatch(/comments\(|body|reviewThreads/);
      calls.discovery++;
      return { repository: { pullRequests: page([]) } };
    }
    if (source.includes("i0:issue(")) {
      active++;
      peak = Math.max(peak, active);
      try {
        hydrationStarted?.();
        await hydrationGate;
        if (refuseHydration) {
          refusals++;
          throw new RateLimitError("quota", { retryAfterSeconds: 30 });
        }
        const items = Object.entries(variables).filter(([key]) => /^n\d+$/.test(key));
        return {
          repository: Object.fromEntries(
            items.map(([key, value]) => {
              const number = Number(value);
              calls.hydrated.push(number);
              return [
                `i${key.slice(1)}`,
                structuredClone(issues.find((item) => item.number === number)),
              ];
            }),
          ),
        };
      } finally {
        active--;
      }
    }
    throw new Error("Unexpected query");
  };
  const cache = new ServeCache({
    ttlMs: 300000,
    clock,
    initialAuth: { host: "github.com", login: "test" },
    authContext: async () => ({ host: "github.com", login: "test" }),
  });
  const readers = cachedBoundaries(
    {
      collect: async () => {
        calls.full++;
        throw new Error("No full snapshot");
      },
      collectShortlist,
      dependencyReport,
      queryWith: (signal) => async (source, variables) => {
        const result = await query(source, variables);
        signal?.throwIfAborted();
        return result;
      },
      now: () => clock.now(),
      env: {},
    },
    cache,
    (repository) => repository === repo,
  );
  const read = (
    number: number | number[],
    signal?: AbortSignal,
    bounds?: Partial<ShortlistBounds>,
  ) =>
    cache.track(false, () =>
      readers.collectShortlist!(
        repo,
        {
          signal,
          bounds,
          select: async () => (Array.isArray(number) ? number : [number]).map((n) => issue(n).url),
        },
        undefined,
        () => clock.now(),
      ),
    );
  return {
    cache,
    calls,
    read,
    setRefusal: () => {
      refuseHydration = true;
    },
    refusals: () => refusals,
    peak: () => peak,
    setPartial: (value: boolean) => {
      partial = value;
    },
    advance: (ms: number) => {
      stamp += ms;
    },
  };
}

describe("serve discovery/hydration cache (#453)", () => {
  it("starts idle, shares whole basics across callers, and hydrates only each caller's selected records", async () => {
    const s = setup();
    try {
      expect(s.calls).toEqual({ discovery: 0, hydrated: [], full: 0 });
      const first = await s.read(1);
      expect(first.value.shortlist?.hydrated).toEqual([issue(1).url]);
      expect(s.calls.hydrated).toEqual([1]);
      const observed = first.value.collection?.coverage.find(
        (c) => c.source === "open-issues",
      )?.observedAt;
      s.advance(1000);
      const second = await s.read(2);
      expect(second.value.shortlist?.hydrated).toEqual([issue(2).url]);
      expect(s.calls.discovery).toBe(2);
      expect(s.calls.hydrated).toEqual([1, 2]);
      expect(second.freshness.map((f) => f.source)).toEqual(["cached", "cached", "live"]);
      const third = await s.read(2);
      expect(third.freshness.every((f) => f.source === "cached")).toBe(true);
      expect(s.calls.hydrated).toEqual([1, 2]);
      expect(third.value.collection?.coverage.find((c) => c.source === "issue")?.observedAt).toBe(
        second.value.collection?.coverage.find((c) => c.source === "issue")?.observedAt,
      );
      expect(
        second.value.collection?.coverage.find((c) => c.source === "open-issues")?.observedAt,
      ).toBe(observed);
      expect(s.calls.full).toBe(0);
      s.advance(300001);
      expect(s.calls.discovery).toBe(2); // expiry does not prefetch
      await s.read(1);
      expect(s.calls.discovery).toBe(4);
      s.cache.refresh(repo);
      await s.read(2);
      expect(s.calls.discovery).toBe(6);
    } finally {
      s.cache.close();
    }
  });

  it("coalesces concurrent discovery while retaining separate selected detail", async () => {
    const s = setup();
    try {
      const [a, b] = await Promise.all([s.read(1), s.read(2)]);
      expect(s.calls.discovery).toBe(2);
      expect(s.cache.status().coalesced).toBe(2);
      expect(a.value.shortlist?.hydrated).toEqual([issue(1).url]);
      expect(b.value.shortlist?.hydrated).toEqual([issue(2).url]);
    } finally {
      s.cache.close();
    }
  });
});

describe("serve discovery coverage and cancellation", () => {
  it("keeps partial discovery out of cache and separates different profile bounds", async () => {
    const s = setup();
    try {
      s.setPartial(true);
      const partial = await s.read(1, undefined, { pages: 1 });
      expect(partial.value.shortlist?.discovered.complete).toBe(false);
      s.setPartial(false);
      await s.read(1, undefined, { pages: 1 });
      expect(s.calls.discovery).toBe(3); // complete PR inventory reused; issues reread
      await s.read(1, undefined, { pages: 2 });
      expect(s.calls.discovery).toBe(5); // coverage bounds are a distinct key
    } finally {
      s.cache.close();
    }
  });

  it("does not let one cancelled discovery waiter abort another caller", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup(gate);
    const controller = new AbortController();
    try {
      const a = s.read(1, controller.signal);
      const b = s.read(2);
      const cancelled = expect(a).rejects.toThrow();
      controller.abort();
      release();
      await cancelled;
      expect((await b).value.shortlist?.hydrated).toEqual([issue(2).url]);
      expect(s.calls.discovery).toBe(2);
    } finally {
      s.cache.close();
    }
  });

  it("coalesces the same selected whole issue records, not just discovery", async () => {
    const s = setup();
    try {
      const [a, b] = await Promise.all([s.read(1), s.read(1)]);
      expect(a.value.shortlist?.hydrated).toEqual([issue(1).url]);
      expect(b.value.shortlist?.hydrated).toEqual([issue(1).url]);
      expect(s.calls.hydrated).toEqual([1]);
    } finally {
      s.cache.close();
    }
  });
});

it("keeps shared selected hydration alive when one native caller cancels", async () => {
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const s = setup(undefined, gate, began);
  const controller = new AbortController();
  try {
    const a = s.read(1, controller.signal);
    const b = s.read(1);
    const cancelled = expect(a).rejects.toThrow();
    await started;
    controller.abort();
    release();
    await cancelled;
    expect((await b).value.shortlist?.hydrated).toEqual([issue(1).url]);
    expect(s.calls.hydrated).toEqual([1]);
  } finally {
    s.cache.close();
  }
});

it("propagates a shared hydration quota refusal to every caller and the service cooldown", async () => {
  const s = setup();
  s.setRefusal();
  try {
    const [a, b] = await Promise.all([s.read(1), s.read(1)]);
    expect(a.value.collection?.quota).toMatchObject({ retryAfterSeconds: 30 });
    expect(b.value.collection?.quota).toMatchObject({ retryAfterSeconds: 30 });
    expect(s.refusals()).toBe(1);
    const refused = await s.read(2);
    // The cache's bounded cooldown is not fabricated as GitHub's reset evidence.
    expect(refused.value.collection?.quota).toEqual({ retryAfterSeconds: null, resetAt: null });
    expect(refused.value.collection?.telemetry.requests).toBe(0);
    expect(refused.value.shortlist?.hydrated).toEqual([]);
    expect(s.refusals()).toBe(1);
  } finally {
    s.cache.close();
  }
});

it("coalesces common issue hydration across partially overlapping selections", async () => {
  const s = setup();
  try {
    const [a, b] = await Promise.all([s.read([1, 2]), s.read([2, 3])]);
    expect(a.value.shortlist?.hydrated).toEqual([issue(1).url, issue(2).url]);
    expect(b.value.shortlist?.hydrated).toHaveLength(2);
    expect(b.value.shortlist?.hydrated).toEqual(
      expect.arrayContaining([issue(2).url, issue(3).url]),
    );
    expect([...s.calls.hydrated].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    s.advance(1000);
    const combined = await s.read([1, 2, 3]);
    expect(combined.value.shortlist?.hydrated).toEqual([issue(1).url, issue(2).url, issue(3).url]);
    expect(s.calls.hydrated).toHaveLength(3);
    expect(combined.value.collection?.telemetry.requests).toBe(0);
  } finally {
    s.cache.close();
  }
});

it("honors the hydration concurrency bound even with single-issue batches", async () => {
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const s = setup(undefined, gate, began);
  try {
    const reading = s.read([1, 2, 3], undefined, { issuesPerRequest: 1, hydrationConcurrency: 1 });
    await started;
    release();
    expect((await reading).value.shortlist?.hydrated).toHaveLength(3);
    expect(s.peak()).toBe(1);
  } finally {
    s.cache.close();
  }
});
