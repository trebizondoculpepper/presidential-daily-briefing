/**
 * `pdb serve` command line (doc/design/serve.md "Command line", #373).
 *
 * Every default and bound the contract leaves open to the owner (#42) is one named constant
 * here, so changing it is a one-line edit with no hunt through the server.
 */
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDuration } from "../github/changes.js";
import { validateHarness } from "../config/harness.js";
import { TRIAGE_ROLES, validateEntryKey } from "../config/identity.js";

/** Default listening port (owner question on #42; arbitrary but stable). */
export const DEFAULT_PORT = 4372;
/** Default listening address: loopback only. */
export const DEFAULT_HOST = "127.0.0.1";
/** Default cache time-to-live: five minutes. */
export const DEFAULT_TTL_MS = 5 * 60_000;
/** Shortest accepted `--ttl`. */
export const MIN_TTL_MS = 60_000;
/** Longest accepted `--ttl` (owner decision: configurable up to ten minutes). */
export const MAX_TTL_MS = 10 * 60_000;
/** How long after `observedAt` an expired entry may still be served as stale (interim rule). */
export const STALE_WINDOW_MS = 30 * 60_000;
/** Longest wait for open responses during graceful shutdown. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** Request body limit for POST routes. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Time allowed for a client to send complete request headers. */
export const HEADERS_TIMEOUT_MS = 10_000;

/** Exit status for invalid arguments or unresolvable startup selection. */
export const EXIT_USAGE = 2;
/** Exit status when the port cannot be bound (in use or not permitted). */
export const EXIT_PORT = 3;
/** Exit status for a second signal during shutdown (128 + SIGINT). */
export const EXIT_FORCED = 130;

/** A usage error: the command exits 2 with this message. */
export class ServeUsageError extends Error {}

/** Validated `pdb serve` options. */
export interface ServeOptions {
  port: number;
  host: string;
  allowRemote: boolean;
  ttlMs: number;
  repos: string[];
  /** Absolute project checkouts, in the order given. */
  projects: string[];
  agent?: string;
  entry?: string;
  harness?: string;
  role?: string;
  /** Which settings were given as arguments, even with a default value (#459 config sources). */
  given?: { port: boolean; ttl: boolean };
}

export const serveHelp = `Usage: pdb serve [--port N] [--host ADDR] [--allow-remote] [--ttl DURATION]
                 [--repo owner/name]... [--project PATH]...
                 [--agent NAME] [--entry KEY | --harness NAME] [--role implementer|designer]
Foreground local HTTP server for Presidential Daily Briefing (doc/design/serve.md): a read-only
JSON API and HTTP MCP over one memory-only cache of collected GitHub facts. Requires
authenticated gh and Node 26+. Never changes GitHub. Stop it with Ctrl-C.
  --repo owner/name     Serve this repository (repeatable)
  --project PATH        Serve the repository of this local checkout (absolute or relative path),
                        and use its configuration and pdb.toml for identity (repeatable)
                        Without one, the saved global registrations (serve.projects) and the
                        working directory's verified Git repository are served too.
  --port N              Port to listen on, 0-65535 (default ${DEFAULT_PORT}; 0 picks a free port)
  --host ADDR           Literal IP address or localhost to listen on (default ${DEFAULT_HOST}).
                        Loopback addresses are always allowed; any other needs --allow-remote
  --allow-remote        Allow a non-loopback --host. The server has no authentication: anyone
                        who can reach it can read what your gh login can see
  --ttl DURATION        How long a collected result is reused, 1m to 10m (default 5m)
  --agent NAME          Default agent for focused reads (a request's agent wins)
  --entry KEY           Without an agent, use [agents.KEY] of the project's pdb.toml
  --harness NAME        Local harness; ambiguous/unverified selection needs --entry KEY
  --role ROLE           Explicit local startup role; a missing identity needs it. A server
                        with exactly one local startup project may initialize that identity.
                        Multiple projects are never bulk initialized; GETs and MCP reads only
                        resolve existing context. Unsupported sessions keep passing --entry
  --help                Show usage
Routes (read-only; every data route accepts repo=owner/name and refresh=true):
  GET  /api/v1/briefing?role=implementer  CLI --json briefing (agent, role, order, since, limit)
  GET  /api/v1/issues/N[/deps|/who]       CLI --issue N, deps N, who N JSON
  GET  /api/v1/prs/N[?history=true]       CLI pr N JSON;  GET /api/v1/team  CLI team JSON
  GET  /api/v1/metrics?view=daily|timing[&days=7|30], ?view=news[&hours=6|1]
                                          Pipeline metrics over a bounded read (no CLI yet)
  POST /api/v1/refresh {"repo":"owner/name"}  Drop cached entries; the next read collects live
  GET  /api/v1/status, /healthz           Status and cache counters; liveness
  /mcp                                    HTTP MCP: the four pdb-mcp read-only tools
  GET  /                                  Read-only dashboard: pick project and role, see next steps
  GET  /api/v1/diagnostics/projects|config|cache|inflight|errors|rules[?repo=&limit=&cursor=]
                                          Read-only state of the server itself; never collects
Results carry freshness (live, cached or stale); a stale result is always incomplete.
HTTP MCP example (verified with Claude Code; doc/reports/serve-http-mcp-acceptance.md):
  claude mcp add --transport http pdb http://127.0.0.1:${DEFAULT_PORT}/mcp
The first stdout line is "pdb serve VERSION listening on URL"; request logs go to stderr.
Loopback binding does not keep out other users of the same machine; there is no token.
On Windows, Ctrl-C and Ctrl-Break stop the server gracefully; ending it from another process
(taskkill /F, a CI runner's SIGTERM) terminates it at once, which loses nothing because the
cache lives only in memory.
Exit: 0 after a graceful stop; 1 startup failure (for example gh not authenticated);
2 invalid arguments; 3 port in use or not permitted; 130 a second Ctrl-C during shutdown.
`;

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const agentPattern = /^[A-Za-z0-9][\w.-]*$/;

/** True for addresses that only this machine can reach. */
export function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

/** Parse and validate `pdb serve` arguments; throws {@link ServeUsageError}. */
export function serveArguments(
  args: string[],
  cwd: string = process.cwd(),
): ServeOptions & { help?: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "allow-remote": { type: "boolean" },
        ttl: { type: "string" },
        repo: { type: "string", multiple: true },
        project: { type: "string", multiple: true },
        agent: { type: "string" },
        entry: { type: "string" },
        harness: { type: "string" },
        role: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new ServeUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help)
    return { help: true, port: 0, host: "", allowRemote: false, ttlMs: 0, repos: [], projects: [] };
  const port = values.port ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535)
    throw new ServeUsageError("--port must be a whole number from 0 to 65535.");
  const host = values.host ?? DEFAULT_HOST;
  if (host !== "localhost" && isIP(host) === 0)
    throw new ServeUsageError("--host must be a literal IP address or localhost.");
  const allowRemote = !!values["allow-remote"];
  if (!isLoopback(host) && !allowRemote)
    throw new ServeUsageError(
      `--host ${host} is reachable from other machines; pass --allow-remote to accept that (no authentication is offered).`,
    );
  let ttlMs = DEFAULT_TTL_MS;
  if (values.ttl !== undefined) {
    try {
      ttlMs = parseDuration(values.ttl);
    } catch {
      ttlMs = Number.NaN;
    }
    if (!(ttlMs >= MIN_TTL_MS && ttlMs <= MAX_TTL_MS))
      throw new ServeUsageError("--ttl must be from 1m to 10m, for example 5m.");
  }
  const repos = values.repo ?? [];
  for (const repo of repos)
    if (!repoPattern.test(repo)) throw new ServeUsageError("--repo must be owner/name.");
  const projects = (values.project ?? []).map((path) => {
    if (!path.trim()) throw new ServeUsageError("--project must not be empty.");
    return resolve(cwd, path);
  });
  // No served target is not a usage error on its own: saved global registrations and the
  // working directory's repository may supply one (#805). Resolution reports "nothing to serve".
  if (values.agent !== undefined && !agentPattern.test(values.agent))
    throw new ServeUsageError("--agent must be an agent name such as kavya_sabbagh.");
  if (values.entry !== undefined && values.harness !== undefined)
    throw new ServeUsageError("Pass either --entry or --harness, not both.");
  try {
    if (values.entry !== undefined) validateEntryKey(values.entry);
    if (values.harness !== undefined) validateHarness(values.harness);
    if (values.role !== undefined && !(TRIAGE_ROLES as readonly string[]).includes(values.role))
      throw new ServeUsageError(
        "--role must be implementer or designer for local identity preparation.",
      );
  } catch (error) {
    throw new ServeUsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    port: Number(port),
    host,
    allowRemote,
    ttlMs,
    given: { port: values.port !== undefined, ttl: values.ttl !== undefined },
    repos,
    projects,
    agent: values.agent,
    entry: values.entry,
    harness: values.harness,
    ...(values.role !== undefined ? { role: values.role } : {}),
  };
}
