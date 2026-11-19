import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  ContinuationSession,
  contextKey,
  hash,
  initialize,
  initializeV2,
  memoryStore,
} from "./core.js";
import type { Read, Runtime, SessionStore } from "./core.js";
import { input, now, read } from "./fixtures.js";
import { StateUnavailable, withSessionStore } from "./state.js";

/** A fresh read whose queue differs per call, so every offer is a genuinely changed queue. */
function changing() {
  let n = 0;
  const next = (): Read => {
    const r = read();
    (r.report as { decisionEngine: { rulesHash: string } }).decisionEngine.rulesHash =
      `rules${n++}`;
    return r;
  };
  const runtime: Runtime = {
    transport: { freshRead: true, read: async () => next() },
    now: () => now,
  };
  return runtime;
}
const event = (i: number) => ({ ...input, eventId: `event-${i}` });

async function offerAndAck(session: ContinuationSession, runtime: Runtime, i: number) {
  const result = await session.evaluate(event(i), runtime);
  expect(result.decision, `offer ${i}: ${result.reason}`).toBe("continue");
  expect(await session.acknowledge(input, event(i).eventId, result.fingerprint!)).toBe(true);
}

describe("approved continuation v2 (#657)", () => {
  it("has no default total-offer cap: more than three offers and 128 callbacks", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input)));
    const runtime = changing();
    for (let i = 0; i < 140; i++) await offerAndAck(session, runtime, i);
    // Dedup still holds for every one of them.
    expect((await session.evaluate(event(3), runtime)).reason).toBe("duplicate-event");
    expect((await session.evaluate(event(0), runtime)).reason).toBe("duplicate-event");
  });

  it("stops at an explicit finite user budget, and a request never widens it", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input, 2)));
    const runtime = changing();
    await offerAndAck(session, runtime, 0);
    await offerAndAck(session, runtime, 1);
    expect((await session.evaluate(event(2), runtime)).reason).toBe("continuation-cap");
    expect((await session.evaluate({ ...event(3), cap: 50 }, runtime)).reason).toBe(
      "continuation-cap",
    );
    // A per-request budget alone also binds.
    const open = new ContinuationSession(memoryStore(initializeV2(input)));
    await offerAndAck(open, runtime, 0);
    expect((await open.evaluate({ ...event(1), cap: 1 }, runtime)).reason).toBe("continuation-cap");
    for (const cap of [0, -1, 1.5, 2_000_000])
      expect((await open.evaluate({ ...event(9), cap }, runtime)).reason).toBe("invalid-budget");
  });

  it("suppresses pending, unchanged and older acknowledged fingerprints", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input)));
    const same: Runtime = {
      transport: { freshRead: true, read: async () => read() },
      now: () => now,
    };
    const first = await session.evaluate(event(0), same);
    expect(first.decision).toBe("continue");
    expect((await session.evaluate(event(1), same)).reason).toBe("delivery-unacknowledged");
    expect(await session.acknowledge(input, "wrong", first.fingerprint!)).toBe(false);
    expect(await session.acknowledge(input, event(0).eventId, hash("x"))).toBe(false);
    expect(await session.acknowledge(input, event(0).eventId, first.fingerprint!)).toBe(true);
    expect((await session.evaluate(event(2), same)).reason).toBe("unchanged");
    // A later change, then a return to the first (older acknowledged) queue: still unchanged.
    await offerAndAck(session, changing(), 3);
    expect((await session.evaluate(event(4), same)).reason).toBe("unchanged");
  });

  it("rejects reentry and concurrent duplicates while a read is in flight", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input)));
    let release!: (r: Read) => void;
    const pending = session.evaluate(event(0), {
      transport: { freshRead: true, read: () => new Promise((resolve) => (release = resolve)) },
      now: () => now,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect((await session.evaluate(event(0), changing())).reason).toBe("duplicate-event");
    expect((await session.evaluate(event(1), changing())).reason).toBe("reentry");
    release(read());
    expect((await pending).decision).toBe("continue");
  });

  it("cancellation before or during I/O never offers and never resumes", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input)));
    const aborted = new AbortController();
    aborted.abort();
    expect((await session.evaluate(event(0), changing(), aborted.signal)).reason).toBe("cancelled");
    const during = new AbortController();
    let release!: (r: Read) => void;
    const result = session.evaluate(
      event(1),
      {
        transport: { freshRead: true, read: () => new Promise((resolve) => (release = resolve)) },
        now: () => now,
      },
      during.signal,
    );
    await new Promise((r) => setTimeout(r, 0));
    during.abort();
    release(read());
    expect((await result).reason).toBe("cancelled");
    // The cancelled callback is recorded: replaying it is a duplicate, never a late offer.
    expect((await session.evaluate(event(1), changing())).reason).toBe("duplicate-event");
  });

  it("reports wrong context and lost state; never initializes implicitly", async () => {
    const session = new ContinuationSession(memoryStore(initializeV2(input)));
    expect((await session.evaluate({ ...event(0), agent: "other" }, changing())).reason).toBe(
      "state-lost",
    );
    expect(
      (await new ContinuationSession(memoryStore()).evaluate(event(0), changing())).reason,
    ).toBe("state-lost");
  });

  it("a crash after the pending commit leaves delivery uncertain, and a retried ack completes", async () => {
    const base = memoryStore(initializeV2(input));
    let failEventWrites = false;
    const flaky: SessionStore = {
      ...base,
      saveEvent: async (key, record) => {
        if (failEventWrites && record.delivery !== "none") throw new Error("disk full");
        return base.saveEvent(key, record);
      },
    };
    const session = new ContinuationSession(flaky);
    failEventWrites = true;
    // The pending offer was committed, then the event write failed: reported, not an offer.
    expect((await session.evaluate(event(0), changing())).reason).toBe("state-unavailable");
    const meta = (await base.meta())!;
    expect(meta.pending).not.toBeNull();
    expect((await session.evaluate(event(1), changing())).reason).toBe("delivery-unacknowledged");
    // An interrupted acknowledgement leaves the offer pending; retrying it completes.
    await expect(
      session.acknowledge(input, event(0).eventId, meta.pending!.fingerprint),
    ).rejects.toThrow("disk full");
    expect((await base.meta())!.pending).not.toBeNull();
    failEventWrites = false;
    expect(await session.acknowledge(input, event(0).eventId, meta.pending!.fingerprint)).toBe(
      true,
    );
    expect((await base.meta())!.pending).toBeNull();
  });
});

describe("v2 private file store (#657)", () => {
  const dir = () => mkdtemp(join(tmpdir(), "pdb-continuation-"));

  it("persists digest-keyed records with no raw identifiers, past 3 offers and 128 events", async () => {
    const d = await dir();
    try {
      await withSessionStore(d, async (stored, create) => {
        expect(stored.version).toBe("none");
        await create(initializeV2(input));
      });
      const runtime = changing();
      for (let i = 0; i < 130; i++)
        await withSessionStore(d, async (stored) => {
          if (stored.version !== 2) throw new Error("expected v2");
          await offerAndAck(new ContinuationSession(stored.store), runtime, i);
        });
      const files = await readdir(d);
      expect(files.filter((f) => f.startsWith("e-"))).toHaveLength(130);
      expect(files.some((f) => f.endsWith(".tmp") || f === "lock")).toBe(false);
      const all = (await Promise.all(files.map((f) => readFile(join(d, f), "utf8")))).join("\n");
      for (const secret of [input.session, "event-1", read().text, "https://"])
        expect(all).not.toContain(secret);
      const meta = JSON.parse(await readFile(join(d, "state.json"), "utf8"));
      expect(meta).toMatchObject({
        schemaVersion: 2,
        budget: null,
        offers: 130,
        events: 130,
        context: contextKey(input),
      });
      await withSessionStore(d, async (stored) => {
        if (stored.version !== 2) throw new Error("expected v2");
        expect(
          (await new ContinuationSession(stored.store).evaluate(event(5), runtime)).reason,
        ).toBe("duplicate-event");
      });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("keeps v1 readable and unchanged, refuses future or corrupt state, and never re-creates", async () => {
    const d = await dir();
    try {
      const v1 = JSON.stringify(initialize(input));
      await writeFile(join(d, "state.json"), v1, { mode: 0o600 });
      await withSessionStore(d, async (stored, create) => {
        expect(stored.version).toBe(1);
        await expect(create(initializeV2(input))).rejects.toBeInstanceOf(StateUnavailable);
      });
      expect(await readFile(join(d, "state.json"), "utf8")).toBe(v1);
      for (const text of [
        '{"schemaVersion":3}',
        "{not json",
        '{"schemaVersion":2,"context":"x"}',
      ]) {
        await writeFile(join(d, "state.json"), text, { mode: 0o600 });
        await expect(withSessionStore(d, async () => undefined)).rejects.toBeInstanceOf(
          StateUnavailable,
        );
        expect(await readFile(join(d, "state.json"), "utf8")).toBe(text);
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
