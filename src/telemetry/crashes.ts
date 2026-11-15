/** Fatal-only reporting with a process-wide opt-out; doc/design/sentry-crash-reporting.md. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { SourceMap } from "node:module";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crashesEnabled } from "./crash-setting.js";
import type { CrashConfigReader } from "./crash-setting.js";
import type { NodeOptions } from "@sentry/node";

type CrashEvent = Parameters<NonNullable<NodeOptions["beforeSend"]>>[0];
export type Mode = "cli" | "serve" | "mcp";
export const crashMessage = "Unhandled PDB exception (details withheld)";
const mechanisms = new Set(["auto.node.onuncaughtexception", "auto.node.onunhandledrejection"]);

function location(filename: string | undefined, root: string): string | undefined {
  if (!filename || [...filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    return;
  let path: string;
  try {
    path = filename.startsWith("file:") ? fileURLToPath(filename) : filename;
  } catch {
    return;
  }
  // Node frames are absolute; a synthetic relative frame is not proof of containment.
  if (!isAbsolute(path)) return;
  let local: string;
  try {
    local = relative(realpathSync(resolve(root)), realpathSync(resolve(path)))
      .split(sep)
      .join("/");
  } catch {
    return;
  }
  if (local.startsWith("../") || isAbsolute(local)) return;
  if (sourcePath.test(local)) return local;
  if (/^dist\/(?:cli|mcp|datalog-[a-zA-Z0-9_-]+)\.mjs$/.test(local)) return local;
  return;
}
const coordinate = (value: number | undefined) =>
  Number.isSafeInteger(value) && value! > 0 && value! <= 10_000_000 ? value : undefined;

const sourcePath = /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:ts|js)$/;
/** Largest shipped map read at crash time; a larger file is not ours and is not parsed. */
const MAX_MAP_BYTES = 32 * 1024 * 1024;
const maps = new Map<string, SourceMap | null>();
/**
 * The shipped map beside a verified built file (`dist/X.mjs.map`, never a `sourceMappingURL`
 * the file names), parsed once. Null when missing, oversized or unreadable.
 */
function shippedMap(root: string, built: string): SourceMap | null {
  const path = join(root, `${built}.map`);
  if (!maps.has(path)) {
    let map: SourceMap | null = null;
    try {
      if (statSync(path).size <= MAX_MAP_BYTES)
        map = new SourceMap(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      map = null;
    }
    maps.set(path, map);
  }
  return maps.get(path)!;
}
/**
 * Maps a built-bundle frame to its public `src/` location through the package's own shipped
 * map. Only an exact generated-line hit with an allowlisted `src/` origin counts; anything else
 * keeps the built location.
 */
export function mappedFrame(
  root: string,
  built: string,
  lineno: number | undefined,
  colno: number | undefined,
): { filename: string; lineno: number; colno: number } | undefined {
  if (!built.startsWith("dist/") || !lineno || !colno) return;
  // A malformed shipped map (bad index, bad mappings) must never fail the report: any lookup
  // or normalisation problem keeps the built location.
  try {
    const map = shippedMap(realpathSync(resolve(root)), built);
    const entry: unknown = map?.findEntry(lineno - 1, colno - 1);
    if (typeof entry !== "object" || entry === null) return;
    const { generatedLine, originalSource, originalLine, originalColumn } = entry as Record<
      string,
      unknown
    >;
    if (
      generatedLine !== lineno - 1 ||
      typeof originalSource !== "string" ||
      typeof originalLine !== "number" ||
      typeof originalColumn !== "number"
    )
      return;
    const filename = posix.normalize(posix.join(posix.dirname(built), originalSource));
    const line = coordinate(originalLine + 1);
    const column = coordinate(originalColumn + 1);
    return sourcePath.test(filename) && line && column
      ? { filename, lineno: line, colno: column }
      : undefined;
  } catch {
    return;
  }
}

/** Construct, never spread, an event. Error strings and arbitrary event fields stay local. */
export function sanitizeCrash(
  event: CrashEvent,
  root: string,
  mode: Mode,
  version?: string | null,
): CrashEvent | null {
  const exceptions = event.exception?.values
    ?.filter((e) => e.mechanism?.handled === false && mechanisms.has(e.mechanism.type))
    .slice(0, 1)
    .map((e) => ({
      type: "Error",
      value: crashMessage,
      mechanism: { handled: false, type: e.mechanism!.type },
      stacktrace: {
        frames: (e.stacktrace?.frames ?? []).slice(-50).flatMap((f) => {
          const filename = location(f.filename, root);
          if (!filename) return [];
          const lineno = coordinate(f.lineno);
          const colno = coordinate(f.colno);
          // A packaged frame reads as its public source location when the shipped map has it.
          const mapped = mappedFrame(root, filename, lineno, colno);
          return [mapped ? { ...mapped, in_app: true } : { filename, lineno, colno, in_app: true }];
        }),
      },
    }));
  if (!exceptions?.length) return null;
  return {
    type: undefined,
    event_id: /^[a-f0-9]{32}$/.test(event.event_id ?? "") ? event.event_id : undefined,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : undefined,
    platform: "node",
    level: "fatal",
    environment: "node",
    release: version && /^[0-9A-Za-z.+-]{1,80}$/.test(version) ? `pdb@${version}` : undefined,
    tags: { mode },
    exception: { values: exceptions },
  };
}

interface Sdk {
  init(options: NodeOptions): unknown;
  onUncaughtExceptionIntegration(options: {
    exitEvenIfOtherHandlersAreRegistered: boolean;
  }): ReturnType<typeof import("@sentry/node").onUncaughtExceptionIntegration>;
  onUnhandledRejectionIntegration(options: {
    mode: "strict";
  }): ReturnType<typeof import("@sentry/node").onUnhandledRejectionIntegration>;
}
export const defaultCrashDsn =
  "https://cc8b7320a11f8073cf52210bb100fe73@o516097.ingest.us.sentry.io/4512437481046016";
let initialized = false;
export async function initializeCrashes(
  mode: Mode,
  root: string,
  version: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  load: () => Promise<Sdk> = () => import("@sentry/node"),
  readConfig?: CrashConfigReader,
): Promise<boolean> {
  if (initialized || env.SENTRY_DISABLED === "1") return false;
  if (!(await crashesEnabled(readConfig))) return false;
  const endpoint = env.SENTRY_DSN ?? defaultCrashDsn;
  try {
    const dsn = new URL(endpoint);
    if (dsn.protocol !== "https:" || !dsn.username || !/^\/[0-9]+$/.test(dsn.pathname))
      return false;
    const sdk = await load();
    sdk.init({
      dsn: endpoint,
      defaultIntegrations: false,
      integrations: [
        sdk.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: true }),
        sdk.onUnhandledRejectionIntegration({ mode: "strict" }),
      ],
      debug: false,
      spotlight: false,
      includeServerName: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      sendClientReports: false,
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      tracesSampleRate: 0,
      profileSessionSampleRate: 0,
      maxBreadcrumbs: 0,
      shutdownTimeout: 1500,
      beforeSend: (event) => sanitizeCrash(event, root, mode, version),
    });
    initialized = true;
    return true;
  } catch {
    // Optional telemetry never replaces a command's result or emits protocol output.
    return false;
  }
}
