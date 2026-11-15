/** Optional fatal-only reporting; doc/design/sentry-crash-reporting.md. */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  if (/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:ts|js)$/.test(local)) return local;
  if (/^dist\/(?:cli|mcp|datalog-[a-zA-Z0-9_-]+)\.mjs$/.test(local)) return local;
  return;
}
const coordinate = (value: number | undefined) =>
  Number.isSafeInteger(value) && value! > 0 && value! <= 10_000_000 ? value : undefined;

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
          return filename
            ? [{ filename, lineno: coordinate(f.lineno), colno: coordinate(f.colno), in_app: true }]
            : [];
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
let initialized = false;
export async function initializeCrashes(
  mode: Mode,
  root: string,
  version: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  load: () => Promise<Sdk> = () => import("@sentry/node"),
): Promise<boolean> {
  if (initialized || env.SENTRY_DISABLED === "1" || !env.SENTRY_DSN) return false;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    if (dsn.protocol !== "https:" || !dsn.username || !/^\/[0-9]+$/.test(dsn.pathname))
      return false;
    const sdk = await load();
    sdk.init({
      dsn: env.SENTRY_DSN,
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
