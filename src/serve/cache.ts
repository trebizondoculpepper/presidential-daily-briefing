/**
 * The `pdb serve` memory cache (doc/design/serve.md "Caching", #373).
 *
 * One cache of whole collected fact results, keyed by authentication context, repository,
 * collector and coverage. Entries are fresh for the TTL; concurrent identical reads join one
 * in-flight collection with a reference-counted abort (generalising `sharedCollect`); at most
 * four distinct collections run at once; LRU bounds of 256 entries and 64 MiB; an expired entry
 * may be served as stale for up to 30 minutes after it was observed when a live collection
 * fails (interim rule pending #369). Nothing is persisted and nothing is collected in the
 * background: an idle server makes no GitHub requests.
 */
import type {
  CacheEntryDiagnostic,
  ErrorEventDiagnostic,
  InflightDiagnostic,
} from "./diagnostics.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { getEventListeners } from "node:events";
import { AuthenticationError, IssueUnavailable, SubjectUnavailable } from "../github/github.js";

/** A read refused because it names a repository outside the served set (#373). */
export class UnservedRepository extends Error {
  constructor(readonly repository: string) {
    super(`${repository} is not served by this pdb serve.`);
  }
}

/** Answers about the subject, not GitHub failures: never stale, never a cooldown. */
const isSubjectAnswer = (error: unknown): boolean =>
  error instanceof IssueUnavailable ||
  error instanceof SubjectUnavailable ||
  error instanceof UnservedRepository;
import type { Clock } from "../mcp/polling.js";
import type { AuthContext } from "./types.js";
import { STALE_WINDOW_MS } from "./options.js";

/** Most entries kept. */
export const MAX_ENTRIES = 256;
/** Recent failures kept for diagnostics (doc/design/serve-diagnostics-api.md "Errors"). */
export const MAX_ERROR_EVENTS = 100;
const errorHints: Record<CollectionCode, string> = {
  GITHUB_RATE_LIMITED:
    "GitHub refused for quota; wait for the reported reset or read cached results. Nothing retries automatically.",
  GITHUB_AUTH: "Run gh auth status on the host running pdb serve.",
  GITHUB_UNAVAILABLE: "Retry the read later; check gh and repository access if it persists.",
};
/** Most approximate bytes kept (JSON size of results measured on insert). */
export const MAX_BYTES = 64 * 1024 * 1024;
/** Most distinct collections running at once; further distinct keys queue in FIFO order. */
export const MAX_CONCURRENT_COLLECTIONS = 4;
/** Longest rate-limit cooldown, whatever GitHub reports. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
/** Cooldown when a rate limit names no retry-after or reset time. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export type CollectionCode = "GITHUB_UNAVAILABLE" | "GITHUB_AUTH" | "GITHUB_RATE_LIMITED";

/** A failed live collection with a sanitized, stable code and message. */
export class CollectionError extends Error {
  constructor(
    readonly code: CollectionCode,
    message: string,
    readonly resetAt: string | null = null,
  ) {
    super(message);
  }
}

/** Freshness of one served result (the envelope's `freshness` block). */
export interface Freshness {
  source: "live" | "cached" | "stale";
  observedAt: string;
  ageSeconds: number;
  ttlSeconds: number;
  expiresAt: string;
  stale: boolean;
  refreshError: { code: CollectionCode; message: string } | null;
}

/** What a cache key covers: the repository, which collector, and its option object. */
export interface CacheKey {
  repository: string;
  collector: string;
  coverage: Record<string, unknown>;
}

const subjectOf = (coverage: Record<string, unknown>): number | null => {
  const n = coverage.issue ?? coverage.n;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const optionKeys = ["tree", "history", "includeTransferred", "staleHours"];
const safeOptions = (coverage: Record<string, unknown>): Record<string, boolean | number> =>
  Object.fromEntries(
    optionKeys.flatMap((k) => {
      const v = coverage[k];
      return typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
        ? [[k, v]]
        : [];
    }),
  );

interface Entry {
  /** Process-scoped opaque ID for diagnostics (#459); never the key or anything derived from it. */
  id: string;
  /** The key's coverage, so diagnostics can show a focused subject without the key itself. */
  coverage: Record<string, unknown>;
  /** Cached reads served from this entry. */
  hits: number;
  key: string;
  repository: string;
  collector: string;
  value: unknown;
  bytes: number;
  observedAt: number;
  generation: number;
  /** Auxiliary read-throughs made while presenting this entry; they expire with it. */
  memo: Map<string, Promise<unknown>>;
}

interface Inflight {
  id: string;
  /** The login this collection runs under; diagnostics show only the current one's (#459). */
  auth: AuthContext;
  repository: string;
  collector: string;
  coverage: Record<string, unknown>;
  startedAt: number;
  promise: Promise<Entry>;
  controller: AbortController;
  waiters: number;
  /** Refresh epoch of the repository when the collection started. */
  epoch: string;
}

interface Scope {
  refresh: boolean;
  records: Freshness[];
  entry?: Entry;
}

export interface CacheOptions {
  ttlMs: number;
  clock: Clock;
  /** Re-read before a live collection at most once per TTL; a change clears the cache. */
  authContext: (signal?: AbortSignal) => Promise<AuthContext>;
  initialAuth: AuthContext;
  staleWindowMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxConcurrent?: number;
  /** Told when the auth context changes (status reports the new one). */
  onAuthChange?: (auth: AuthContext) => void;
}

/** Canonical JSON: sorted keys, absent (undefined) fields omitted. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const sizeOf = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    // Unserializable values are never produced by the collectors; count them as large.
    return MAX_BYTES;
  }
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("Aborted", "AbortError");

/** Sanitized classification of a collector failure; no stderr, arguments or paths survive. */
export function classifyFailure(error: unknown, now: number): CollectionError {
  if (error instanceof CollectionError) return error;
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    rateLimited?: unknown;
    retry?: { retryAfterSeconds?: number | null; resetAt?: string | null };
    message?: unknown;
  };
  if (record.rateLimited === true) {
    const retry = record.retry ?? {};
    let until = now + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    if (typeof retry.retryAfterSeconds === "number") until = now + retry.retryAfterSeconds * 1000;
    else if (retry.resetAt && Number.isFinite(Date.parse(retry.resetAt)))
      until = Date.parse(retry.resetAt);
    until = Math.min(Math.max(until, now), now + MAX_RATE_LIMIT_COOLDOWN_MS);
    const resetAt = new Date(until).toISOString();
    return new CollectionError(
      "GITHUB_RATE_LIMITED",
      `GitHub rate limited this login; live reads resume after ${resetAt}.`,
      resetAt,
    );
  }
  // Typed signals only: gh's general advice mentions authentication on every failure, so
  // message text would turn outages, timeouts and 5xx answers into auth failures.
  if (error instanceof AuthenticationError)
    return new CollectionError(
      "GITHUB_AUTH",
      "GitHub refused the gh login. Check gh auth status, then retry.",
    );
  return new CollectionError(
    "GITHUB_UNAVAILABLE",
    "GitHub evidence could not be collected. Check gh authentication and repository access, then retry.",
  );
}

/** The memory cache. One instance per server. */
export class ServeCache {
  readonly ttlMs: number;
  private readonly staleWindowMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private bytes = 0;
  private generation = 0;
  /** Bumped by refresh: collections that started before it never insert. */
  private readonly epochs = new Map<string, number>();
  private auth: AuthContext;
  private authCheckedAt: number;
  private authCheck: Promise<void> | null = null;
  private cooldownUntil = 0;
  private cooldownError: CollectionError | null = null;
  private sweepTimer: unknown = null;
  private closed = false;
  private readonly scope = new AsyncLocalStorage<Scope>();
  /** Aborted by close(): the shared login check and memoised reads never outlive the cache. */
  private readonly lifetime = new AbortController();
  /** Every collection not yet settled, including ones a refresh replaced in `inflight`. */
  private readonly flights = new Set<Inflight>();
  private readonly lastSeen = new Map<
    string,
    { observedAt: string | null; lastError: { code: string; at: string } | null }
  >();
  readonly counters = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };
  private nextId = 0;
  /** Bounded recent failures for diagnostics (#459): newest last, at most MAX_ERROR_EVENTS. */
  private readonly errors: ErrorEventDiagnostic[] = [];
  private discardedErrors = 0;
  private readonly errorsSince = new Date().toISOString();

  /**
   * Remember one collection failure, built field by field: the safe code, the same-response
   * category and quota numbers the #293 evidence proved, and a fixed hint. Never GitHub's
   * message, stderr, a body or a key.
   */
  private recordError(
    key: CacheKey,
    failure: CollectionError,
    error: unknown,
    auth: AuthContext,
  ): void {
    const evidence = (error as { evidence?: unknown } | null)?.evidence as
      | { category?: unknown; observation?: Record<string, unknown> }
      | undefined;
    const o = evidence?.observation;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    this.errors.push({
      id: `e${++this.nextId}`,
      repository: key.repository.toLowerCase(),
      auth: `${auth.host}/${auth.login}`,
      at: new Date(this.now()).toISOString(),
      operation: key.collector,
      code: failure.code,
      category: typeof evidence?.category === "string" ? evidence.category : null,
      subject: subjectOf(key.coverage),
      hint: errorHints[failure.code],
      quota: o
        ? {
            resource: typeof o.resource === "string" ? o.resource : null,
            limit: num(o.limit),
            remaining: num(o.remaining),
            resetAt: typeof o.resetAt === "string" ? o.resetAt : null,
          }
        : null,
    });
    if (this.errors.length > MAX_ERROR_EVENTS) {
      this.errors.shift();
      this.discardedErrors++;
    }
  }

  /** Abort listeners currently registered on the cache-lifetime signal (leak tests). */
  lifetimeListeners(): number {
    return getEventListeners(this.lifetime.signal, "abort").length;
  }

  constructor(private readonly options: CacheOptions) {
    this.ttlMs = options.ttlMs;
    this.staleWindowMs = options.staleWindowMs ?? STALE_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_COLLECTIONS;
    this.auth = options.initialAuth;
    this.authCheckedAt = options.clock.now().getTime();
    this.scheduleSweep();
  }

  private now(): number {
    return this.options.clock.now().getTime();
  }

  private keyOf(key: CacheKey): string {
    return [
      `${this.auth.host}/${this.auth.login}`,
      key.repository.toLowerCase(),
      key.collector,
      canonical(key.coverage),
    ].join("\u0000");
  }

  /** Status counters (doc/design/serve.md "/api/v1/status"). */
  status(): Record<string, number> {
    return {
      entries: this.entries.size,
      approxBytes: this.bytes,
      ...this.counters,
      inflight: this.inflight.size,
    };
  }

  /** Per repository: latest observation and last error. */
  repositories(): Record<string, { observedAt: string | null; lastError: unknown }> {
    return Object.fromEntries(this.lastSeen);
  }

  currentAuth(): AuthContext {
    return this.auth;
  }

  /**
   * Metadata of held entries and in-flight collections for the diagnostics API (#459). Reads
   * only: it never collects, refreshes, renews or sweeps. Values, keys, auth and raw coverage
   * strings stay inside; only the typed fields below leave.
   */
  diagnostics(): {
    entries: CacheEntryDiagnostic[];
    inflight: InflightDiagnostic[];
    errors: Omit<ErrorEventDiagnostic, "auth">[];
    discardedErrors: number;
    errorsSince: string;
  } {
    const now = this.now();
    const entries = [...this.entries.values()].map((e): CacheEntryDiagnostic => {
      const age = now - e.observedAt;
      return {
        id: e.id,
        repository: e.repository,
        collector: e.collector,
        subject: subjectOf(e.coverage),
        options: safeOptions(e.coverage),
        observedAt: new Date(e.observedAt).toISOString(),
        expiresAt: new Date(e.observedAt + this.ttlMs).toISOString(),
        ageMs: age,
        approxBytes: e.bytes,
        state:
          age < this.ttlMs
            ? "fresh"
            : age <= Math.max(this.staleWindowMs, this.ttlMs)
              ? "stale-eligible"
              : "expired",
        hits: e.hits,
      };
    });
    // A collection still running for a retired login stays with its own waiters, but is never
    // shown under the new one: auth contexts stay isolated in diagnostics too.
    const inflight = [...this.flights]
      .filter((f) => f.auth === this.auth)
      .map((f): InflightDiagnostic => ({
        id: f.id,
        repository: f.repository,
        collector: f.collector,
        subject: subjectOf(f.coverage),
        startedAt: new Date(f.startedAt).toISOString(),
        elapsedMs: now - f.startedAt,
        waiters: f.waiters,
        cancelled: f.controller.signal.aborted,
      }));
    const auth = `${this.auth.host}/${this.auth.login}`;
    return {
      entries,
      inflight,
      // Only the current login's failures, without the internal auth tag.
      errors: this.errors.filter((e) => e.auth === auth).map(({ auth: _auth, ...event }) => event),
      discardedErrors: this.discardedErrors,
      errorsSince: this.errorsSince,
    };
  }

  /**
   * Run `work` with its own record of every cached read it makes, and whether reads bypass a
   * fresh entry (`refresh=true`). Per-call context never leaks between concurrent requests.
   */
  async track<T>(
    refresh: boolean,
    work: () => Promise<T>,
  ): Promise<{ value: T; freshness: Freshness[] }> {
    const scope: Scope = { refresh, records: [] };
    const value = await this.scope.run(scope, work);
    return { value, freshness: scope.records };
  }

  /**
   * Memoise an auxiliary read (provenance permissions, delivery evidence) inside the entry the
   * current request is presenting, so it expires with that entry. Outside a cached read it is
   * a plain call. A failure is never memoised, and a waiter whose own call was not cancelled
   * retries on its own when a shared attempt was cancelled by someone else.
   */
  async memo<T>(key: string, call: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
    const entry = this.scope.getStore()?.entry;
    if (!entry || !this.entries.has(entry.key) || this.entries.get(entry.key) !== entry)
      return call();
    const existing = entry.memo.get(key) as Promise<T> | undefined;
    if (existing)
      return existing.catch(() => {
        return call();
      });
    // close() rejects a pending memoised read at once; the request's own signal (which serve's
    // shutdown aborts) stops the gh child behind it.
    const lifetime = this.lifetime.signal;
    // The listener is removed as soon as the read settles, so a long-running server does not
    // accumulate one per memoised read on the lifetime signal.
    const bounded = lifetime.aborted
      ? Promise.reject(abortError(lifetime))
      : new Promise<T>((resolve, reject) => {
          const onClose = () => reject(abortError(lifetime));
          lifetime.addEventListener("abort", onClose, { once: true });
          call().then(
            (value) => {
              lifetime.removeEventListener("abort", onClose);
              resolve(value);
            },
            (error: unknown) => {
              lifetime.removeEventListener("abort", onClose);
              reject(error);
            },
          );
        });
    const promise = bounded.then((value) => {
      if (!keep(value)) entry.memo.delete(key);
      else if (this.entries.get(entry.key) === entry) {
        const extra = sizeOf(value);
        entry.bytes += extra;
        this.bytes += extra;
        this.enforceBounds(entry.key);
      }
      return value;
    });
    entry.memo.set(key, promise);
    promise.catch(() => entry.memo.delete(key));
    return promise;
  }

  /**
   * Drop every entry of one repository (or all), optionally of one collector only; returns how
   * many were dropped. Collections already running when this is called never insert.
   */
  refresh(repository?: string, collectors?: readonly string[]): number {
    let dropped = 0;
    for (const [key, entry] of this.entries)
      if (
        (!repository || entry.repository === repository.toLowerCase()) &&
        (!collectors || collectors.includes(entry.collector))
      ) {
        this.remove(key);
        dropped++;
      }
    if (repository) {
      const lower = repository.toLowerCase();
      this.epochs.set(lower, (this.epochs.get(lower) ?? 0) + 1);
    } else this.epochs.set("*", (this.epochs.get("*") ?? 0) + 1);
    return dropped;
  }

  /** Stop the sweep and abort every in-flight collection. */
  close(): void {
    this.closed = true;
    this.lifetime.abort(new Error("pdb serve cache closed."));
    if (this.sweepTimer !== null) this.options.clock.clearTimeout(this.sweepTimer);
    for (const flight of this.flights) flight.controller.abort();
    this.inflight.clear();
    // Queued collections were aborted above; their tickets are already gone. Any left start
    // nothing: a released collection checks `closed` before running.
    for (const release of this.queue.splice(0)) release();
  }

  private epochOf(repository: string): string {
    const lower = repository.toLowerCase();
    return `${this.epochs.get(lower) ?? 0}/${this.epochs.get("*") ?? 0}`;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private enforceBounds(keep?: string): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      // The least recently used first; the entry just written goes last, and only if it
      // alone exceeds the byte bound.
      if (key === keep && this.entries.size > 1) continue;
      this.remove(key);
      this.counters.evictions++;
    }
    if (this.bytes > this.maxBytes && keep && this.entries.has(keep)) {
      this.remove(keep);
      this.counters.evictions++;
    }
  }

  /** Drop entries past their stale window (expired ones inside it stay for the stale rule). */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (now - entry.observedAt > Math.max(this.staleWindowMs, this.ttlMs)) this.remove(key);
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    this.sweepTimer = this.options.clock.setTimeout(() => {
      this.sweep();
      this.scheduleSweep();
    }, this.ttlMs);
  }

  freshnessOf(
    entry: Entry,
    source: Freshness["source"],
    refreshError: CollectionError | null = null,
  ): Freshness {
    const now = this.now();
    return {
      source,
      observedAt: new Date(entry.observedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((now - entry.observedAt) / 1000)),
      ttlSeconds: this.ttlMs / 1000,
      expiresAt: new Date(entry.observedAt + this.ttlMs).toISOString(),
      stale: source === "stale",
      refreshError: refreshError && { code: refreshError.code, message: refreshError.message },
    };
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ticket = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const at = this.queue.indexOf(ticket);
        if (at !== -1) this.queue.splice(at, 1);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(ticket);
    });
    // The releaser handed its slot over; `running` is unchanged.
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.running--;
  }

  /** Re-read the login before live work at most once per TTL; a change clears the cache. */
  private async checkAuth(): Promise<void> {
    if (this.now() - this.authCheckedAt < this.ttlMs) return;
    // Shared by every collection that needs it, so it takes no caller's signal: one cancelled
    // request must not fail another's check (gh's own timeout bounds it).
    this.authCheck ??= (async () => {
      try {
        const auth = await this.options.authContext(this.lifetime.signal);
        this.authCheckedAt = this.now();
        if (auth.host !== this.auth.host || auth.login !== this.auth.login) {
          this.auth = auth;
          this.cooldownUntil = 0;
          for (const key of this.entries.keys()) this.remove(key);
          this.options.onAuthChange?.(auth);
        }
      } catch (error) {
        // Only a real authentication failure is GITHUB_AUTH; an outage stays unavailable.
        if (error instanceof AuthenticationError)
          throw new CollectionError(
            "GITHUB_AUTH",
            "The gh login could not be read. Run gh auth status, then retry.",
          );
        throw classifyFailure(error, this.now());
      } finally {
        this.authCheck = null;
      }
    })();
    return this.authCheck;
  }

  /**
   * Start the rate-limit cooldown for a quota refusal that a read reported in its result rather
   * than threw (#367: a focused read that stopped early returns an incomplete answer). The same
   * bounds and defaults as a thrown RateLimitError apply.
   */
  noteQuotaRefusal(retry: { retryAfterSeconds?: number | null; resetAt?: string | null }): void {
    this.noteRateLimit(classifyFailure({ rateLimited: true, retry }, this.now()));
  }

  private noteRateLimit(failure: CollectionError): void {
    if (failure.code !== "GITHUB_RATE_LIMITED" || !failure.resetAt) return;
    const until = Date.parse(failure.resetAt);
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.cooldownError = failure;
    }
  }

  private startCollection<T>(
    key: string,
    cacheKey: CacheKey,
    produce: (signal: AbortSignal) => Promise<T>,
    keep: (value: T) => boolean,
  ): Inflight {
    const { repository, collector } = cacheKey;
    const controller = new AbortController();
    const generation = ++this.generation;
    const epoch = this.epochOf(repository);
    const flight = {
      id: `f${++this.nextId}`,
      auth: this.auth,
      repository: repository.toLowerCase(),
      collector,
      coverage: cacheKey.coverage,
      startedAt: this.now(),
      controller,
      waiters: 0,
      epoch,
    } as Inflight;
    this.flights.add(flight);
    flight.promise = (async () => {
      try {
        await this.acquire(controller.signal);
      } catch (error) {
        // Cancelled while queued: it never held a slot.
        this.flights.delete(flight);
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
        throw error;
      }
      try {
        if (this.closed)
          throw new CollectionError("GITHUB_UNAVAILABLE", "pdb serve is shutting down.");
        // A cooldown that began while this read was queued applies to it too.
        if (this.cooldownUntil > this.now() && this.cooldownError) throw this.cooldownError;
        await this.checkAuth();
        // The login these facts are collected under. If it changes before the collection
        // finishes (another collection noticed gh auth switch), the result is still returned
        // to this flight's own waiters, whose key names the old login, but never stored where
        // the new login's reads would find it.
        const collectedAs = this.auth;
        flight.auth = collectedAs;
        const storeKey = this.keyOf(cacheKey);
        const value = await produce(controller.signal);
        const entry: Entry = {
          id: `c${++this.nextId}`,
          coverage: cacheKey.coverage,
          hits: 0,
          key: storeKey,
          repository: repository.toLowerCase(),
          collector,
          value,
          bytes: sizeOf(value),
          observedAt: this.now(),
          generation,
          memo: new Map(),
        };
        const current = this.entries.get(storeKey);
        // Never overwrite newer facts, and never insert across a refresh that came later.
        if (
          !this.closed &&
          this.auth === collectedAs &&
          keep(value) &&
          this.epochOf(repository) === epoch &&
          (!current || current.generation < generation)
        ) {
          this.remove(storeKey);
          this.entries.set(storeKey, entry);
          this.bytes += entry.bytes;
          this.enforceBounds(storeKey);
        }
        this.lastSeen.set(repository.toLowerCase(), {
          observedAt: new Date(entry.observedAt).toISOString(),
          lastError: this.lastSeen.get(repository.toLowerCase())?.lastError ?? null,
        });
        return entry;
      } catch (error) {
        // Already aborted here means every waiter cancelled (or shutdown began): no GitHub
        // failure happened, so it is not recorded (#459). Decided before aborting siblings.
        const cancelled = controller.signal.aborted;
        // A failed collection aborts sibling requests still paginating.
        controller.abort();
        // Start a rate-limit cooldown before this slot is released, so a read queued behind
        // this one sees it (the waiters' own handling runs only after the release).
        if (!isSubjectAnswer(error)) {
          // Decided before the cooldown is updated: a refusal by an existing cooldown ran
          // nothing, while a failure that starts a cooldown is the one to record (#459).
          const refusedByCooldown = this.cooldownError !== null && error === this.cooldownError;
          const failure = classifyFailure(error, this.now());
          this.noteRateLimit(failure);
          // Once per shared collection (not per waiter), under the login it ran as.
          if (!refusedByCooldown && !cancelled && !this.closed)
            this.recordError(cacheKey, failure, error, flight.auth);
        }
        throw error;
      } finally {
        this.release();
        this.flights.delete(flight);
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
      }
    })();
    // Waiters observe the outcome themselves; an abandoned flight never rejects unhandled.
    flight.promise.catch(() => {});
    this.inflight.set(key, flight);
    return flight;
  }

  /** Join a flight with this caller's own cancellation (reference-counted abort). */
  private wait(key: string, flight: Inflight, signal?: AbortSignal): Promise<Entry> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    flight.waiters++;
    return new Promise<Entry>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters--;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        // Abort the shared collection only when no other caller (JSON or MCP) still waits.
        if (flight.waiters === 0) {
          flight.controller.abort();
          if (this.inflight.get(key) === flight) this.inflight.delete(key);
        }
        reject(abortError(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (entry) => leave() && resolve(entry),
        (error: unknown) => leave() && reject(error),
      );
    });
  }

  /**
   * Read one key: a fresh entry, else a live collection (joined when one is in flight), else,
   * if that fails, a stale entry within the stale window, else the sanitized failure. Records
   * freshness in the current {@link track} scope and makes the entry the memo target.
   */
  async read<T>(
    cacheKey: CacheKey,
    produce: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    /** Whether a produced value is definitive enough to store; others are returned only. */
    keep: (value: T) => boolean = () => true,
  ): Promise<T> {
    if (this.closed) throw new CollectionError("GITHUB_UNAVAILABLE", "pdb serve is shutting down.");
    // A caller already gone never starts (or counts against) a collection.
    if (signal?.aborted) throw abortError(signal);
    const scope = this.scope.getStore();
    const refresh = scope?.refresh ?? false;
    const key = this.keyOf(cacheKey);
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && now - existing.observedAt > Math.max(this.staleWindowMs, this.ttlMs))
      this.remove(key);
    const entry = this.entries.get(key);
    const served = (found: Entry, source: Freshness["source"], error?: CollectionError) => {
      if (scope) {
        scope.records.push(this.freshnessOf(found, source, error ?? null));
        scope.entry = found;
      }
      return found.value as T;
    };
    if (entry && !refresh && now - entry.observedAt < this.ttlMs) {
      // LRU: most recently used moves to the end.
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.counters.hits++;
      entry.hits++;
      return served(entry, "cached");
    }
    this.counters.misses++;
    // refresh=true never joins a collection that started before this request arrived, and no
    // read joins one that started before a refresh of its repository (POST /api/v1/refresh).
    let flight = refresh ? undefined : this.inflight.get(key);
    if (flight && flight.epoch !== this.epochOf(cacheKey.repository)) flight = undefined;
    if (flight) this.counters.coalesced++;
    try {
      if (!flight) {
        if (this.cooldownUntil > now && this.cooldownError) throw this.cooldownError;
        flight = this.startCollection(key, cacheKey, produce, keep);
      }
      return served(await this.wait(key, flight, signal), "live");
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      // An unavailable issue is a result (its diagnosis), not a failure: never stale.
      if (isSubjectAnswer(error)) throw error;
      const failure = classifyFailure(error, this.now());
      this.noteRateLimit(failure);
      this.lastSeen.set(cacheKey.repository.toLowerCase(), {
        observedAt: this.lastSeen.get(cacheKey.repository.toLowerCase())?.observedAt ?? null,
        lastError: { code: failure.code, at: new Date(this.now()).toISOString() },
      });
      const previous = this.entries.get(key);
      if (previous && this.now() - previous.observedAt <= this.staleWindowMs)
        return served(previous, "stale", failure);
      if (previous) this.remove(key);
      throw failure;
    }
  }
}
