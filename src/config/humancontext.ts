/**
 * The human an agent works for (#664, doc/design/human-assignment-safeguard.md "Human identity and
 * default ownership"). One shared resolver for every surface.
 *
 * The employing human is, by default, the authenticated GitHub user for the target host: the
 * login `gh` acts as. It is never guessed from the agent name, git author, PR creator or a display
 * selector, and it stays separate from agent, platform and role. The result always says where it
 * came from and how current it is:
 *
 * - `current`: read just now from the authenticated login;
 * - `last-known`: GitHub did not answer, so the last login successfully read for this host is used,
 *   with its observation time (#693: an outage is not evidence of a change);
 * - `unresolved`: no login is known, with the reason. Missing credentials are reported as such,
 *   never as an outage. This resolver states facts only; what a workflow may do without a known
 *   human is decided elsewhere (native rules, #693), not here.
 *
 * Last-known records are kept per OS user in the pdb cache directory, keyed by host, so an
 * account read on one host is never reused for another. The resolver changes no assignment,
 * claim or GitHub state.
 */
import { join } from "node:path";
import { defaultCacheDir } from "../updates/updatecache.js";
import { updateJsonFile, type SafeFs } from "./safejson.js";

export type HumanContext =
  | { state: "current"; host: string; login: string; source: "gh-login"; observedAt: string }
  | {
      state: "last-known";
      host: string;
      login: string;
      source: "gh-login";
      observedAt: string;
      /** Why the current login could not be read. */
      reason: string;
    }
  | { state: "unresolved"; host: string; login: null; source: "none"; reason: string };

/** The authenticated login boundary: `gh api user` in production (`ghAuthContext`). */
export type AuthContextReader = (signal?: AbortSignal) => Promise<{ host: string; login: string }>;

export interface HumanContextOptions {
  /** The GitHub host of the target repository; repositories pdb manages are on github.com. */
  host?: string;
  /** Offline reads make no GitHub request: only the last-known record can answer. */
  offline?: boolean;
  now?: () => Date;
  cacheDir?: string;
  fs?: SafeFs;
  signal?: AbortSignal;
}

export const humanCacheFile = "human-context.json";
/** Set to any value to resolve no employing human (tests and packaged smoke runs). */
export const humanContextOptOutEnv = "PDB_NO_HUMAN_CONTEXT";
/** Whether the production front ends resolve the employing human. */
export const humanContextEnabled = (): boolean => !process.env[humanContextOptOutEnv];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const validLogin = (v: unknown): v is string => typeof v === "string" && /^[\w.-]+$/.test(v);

/** A stored record for `host`, or null (absent, unreadable, foreign schema or bad values). */
function storedFor(value: unknown, host: string): { login: string; observedAt: string } | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.hosts)) return null;
  const entry = value.hosts[host];
  if (!isRecord(entry) || !validLogin(entry.login)) return null;
  if (typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt)))
    return null;
  return { login: entry.login, observedAt: entry.observedAt };
}

/** Read the last-known record for `host` without writing anything. */
async function lastKnown(
  path: string,
  host: string,
  fs: SafeFs | undefined,
): Promise<{ login: string; observedAt: string } | null> {
  let found: { login: string; observedAt: string } | null = null;
  // updateJsonFile with a keep decision reads under the lock and never writes.
  await updateJsonFile(
    path,
    (current) => {
      if (current.state === "value") found = storedFor(current.value, host);
      return { keep: "read only" };
    },
    { lockWaitMs: 250, ...(fs ? { fs } : {}) },
  ).catch(() => undefined);
  return found;
}

/** Record `login` as last known for `host`; failures never fail the resolution. */
async function remember(
  path: string,
  host: string,
  login: string,
  observedAt: string,
  fs: SafeFs | undefined,
): Promise<void> {
  await updateJsonFile(
    path,
    (current) => {
      const value = current.state === "value" && isRecord(current.value) ? current.value : {};
      const hosts = isRecord(value.hosts) && value.schemaVersion === 1 ? value.hosts : {};
      const existing = storedFor({ schemaVersion: 1, hosts }, host);
      if (existing?.login === login && existing.observedAt === observedAt)
        return { keep: "unchanged" };
      return { write: { schemaVersion: 1, hosts: { ...hosts, [host]: { login, observedAt } } } };
    },
    { lockWaitMs: 250, ...(fs ? { fs } : {}) },
  ).catch(() => undefined);
}

/** Resolve the employing human for the target host. Never throws for GitHub or cache failures. */
export async function resolveHumanContext(
  read: AuthContextReader | undefined,
  options: HumanContextOptions = {},
): Promise<HumanContext> {
  const host = options.host ?? "github.com";
  const now = options.now ?? (() => new Date());
  const path = join(options.cacheDir ?? defaultCacheDir(), humanCacheFile);
  const fallback = async (reason: string): Promise<HumanContext> => {
    const known = await lastKnown(path, host, options.fs);
    return known
      ? {
          state: "last-known",
          host,
          login: known.login,
          source: "gh-login",
          observedAt: known.observedAt,
          reason,
        }
      : {
          state: "unresolved",
          host,
          login: null,
          source: "none",
          reason: `${reason}; no earlier login is recorded for ${host}`,
        };
  };
  if (options.offline || !read)
    return fallback(options.offline ? "offline read" : "no login reader");
  let auth: { host: string; login: string };
  try {
    auth = await read(options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    // Missing or refused credentials are a fact about this machine, not an outage: never
    // substitute an older login for an account that is no longer signed in.
    if ((error as { authentication?: unknown }).authentication === true)
      return {
        state: "unresolved",
        host,
        login: null,
        source: "none",
        reason: `gh is not signed in to ${host} (run gh auth status)`,
      };
    return fallback(`GitHub did not answer the login read (${(error as Error).message})`);
  }
  // The reader's host is the one gh actually used; a different target host is not answered by it.
  if (auth.host !== host) return fallback(`gh is signed in to ${auth.host}, not ${host}`);
  if (!validLogin(auth.login))
    return {
      state: "unresolved",
      host,
      login: null,
      source: "none",
      reason: "gh returned no valid login",
    };
  const observedAt = now().toISOString();
  await remember(path, host, auth.login, observedAt, options.fs);
  return { state: "current", host, login: auth.login, source: "gh-login", observedAt };
}

/** One text line for briefings and diagnostics. */
export function humanContextText(h: HumanContext): string {
  if (h.state === "current") return `Working for: ${h.login} (${h.host}, the signed-in gh account)`;
  if (h.state === "last-known")
    return `Working for: ${h.login} (${h.host}, last known at ${h.observedAt}; ${h.reason})`;
  return `Working for: unknown (${h.host}: ${h.reason})`;
}

/**
 * The single execution-human context of a local `pdb serve` process (#664): the gh account it
 * read at startup. Selecting another project or a display filter never switches it.
 */
export const serverHumanContext = (
  auth: { host: string; login: string },
  startedAt: Date,
): HumanContext => ({
  state: "current",
  host: auth.host,
  login: auth.login,
  source: "gh-login",
  observedAt: startedAt.toISOString(),
});
