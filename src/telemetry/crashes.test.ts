import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crashMessage, initializeCrashes, sanitizeCrash } from "./crashes.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
type Input = Parameters<typeof sanitizeCrash>[0];
const event = (filename: string): Input => ({
  type: undefined,
  event_id: "a".repeat(32),
  timestamp: 1234,
  message: "secret message",
  user: { email: "private@example.com" },
  extra: { credential: "secret-key" },
  tags: { secret: "secret" },
  request: { url: "https://private.example/?token=secret" },
  breadcrumbs: [{ message: "private ticket" }],
  exception: {
    values: [
      {
        type: "PrivateName",
        value: "private body",
        mechanism: { type: "auto.node.onuncaughtexception", handled: false },
        stacktrace: {
          frames: [
            {
              filename,
              function: "private-function",
              lineno: 10,
              colno: 2,
              vars: { password: "secret" },
              pre_context: ["secret source"],
            },
          ],
        },
      },
    ],
  },
});

describe("fatal telemetry boundary", () => {
  it("constructs an allowlisted event with no inherited content", () => {
    const clean = sanitizeCrash(
      event(new URL("./crashes.ts", import.meta.url).href),
      root,
      "mcp",
      "0.11.0",
    );
    expect(clean).toMatchObject({
      level: "fatal",
      environment: "node",
      tags: { mode: "mcp" },
      release: "pdb@0.11.0",
    });
    expect(clean?.exception?.values?.[0]).toMatchObject({
      type: "Error",
      value: crashMessage,
      stacktrace: {
        frames: [{ filename: "src/telemetry/crashes.ts", lineno: 10, colno: 2, in_app: true }],
      },
    });
    expect(JSON.stringify(clean)).not.toMatch(/secret|private|PrivateName/);
    expect(Object.keys(clean!)).toEqual([
      "type",
      "event_id",
      "timestamp",
      "platform",
      "level",
      "environment",
      "release",
      "tags",
      "exception",
    ]);
  });
  it("drops handled, message-only and foreign mechanisms", () => {
    expect(sanitizeCrash({ type: undefined, message: "expected" }, root, "cli")).toBeNull();
    for (const mechanism of [
      { handled: true, type: "auto.node.onuncaughtexception" },
      { handled: false, type: "secret-type" },
    ]) {
      const e = event("/private/file.ts");
      e.exception!.values![0]!.mechanism = mechanism;
      expect(sanitizeCrash(e, root, "cli")).toBeNull();
    }
  });
  it("rejects external, missing, malformed URL and symlink-escaping frames", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pdb-crash-"));
    try {
      await mkdir(join(temporary, "src"));
      const outside = join(temporary, "outside.ts");
      await writeFile(outside, "");
      if (process.platform !== "win32") await symlink(outside, join(temporary, "src", "escape.ts"));
      for (const filename of [
        outside,
        "src/relative.ts",
        "file://%bad",
        join(temporary, "src", "missing.ts"),
        pathToFileURL(join(temporary, "src", "escape.ts")).href,
      ]) {
        const clean = sanitizeCrash(
          event(filename),
          join(temporary, "src"),
          "serve",
          "bad/release",
        );
        expect(clean?.exception?.values?.[0]?.stacktrace?.frames).toEqual([]);
        expect(clean?.release).toBeUndefined();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it("does not load an SDK for absent, disabled or invalid configuration", async () => {
    const load = async (): Promise<never> => {
      throw new Error("must not load");
    };
    for (const env of [
      {},
      { SENTRY_DSN: "bad" },
      { SENTRY_DSN: "https://public@example.invalid/1", SENTRY_DISABLED: "1" },
    ])
      expect(await initializeCrashes("cli", root, "0.11.0", env, load)).toBe(false);
  });
  it("sends only an error envelope and exits on a real unhandled rejection", async () => {
    const script = `
      import * as sdk from '@sentry/node';
      import { initializeCrashes } from './src/telemetry/crashes.ts';
      await initializeCrashes('mcp', process.cwd(), '0.11.0', {SENTRY_DSN:'https://public@example.invalid/1'}, async()=>({
        ...sdk, init: options=>sdk.init({...options,transport:()=>({
          send: async envelope=>{process.stdout.write(JSON.stringify(envelope)+'\\n');return {statusCode:200};},
          flush:async()=>true
        })})
      }));
      Promise.reject(new Error('DO_NOT_SEND_private_payload'));
    `;
    let stdout = "";
    let code: unknown;
    try {
      await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: root,
        timeout: 8000,
        env: { ...process.env, SENTRY_DSN: "", SENTRY_SPOTLIGHT: "", SENTRY_DEBUG: "" },
      });
    } catch (e) {
      const failure = e as { code: unknown; stdout: string };
      stdout = failure.stdout;
      code = failure.code;
    }
    expect(code).toBe(1);
    const envelope = JSON.parse(stdout.trim()) as [unknown, [{ type: string }, Input][]];
    expect(envelope[1].map(([header]) => header.type)).toEqual(["event"]);
    expect(JSON.stringify(envelope)).not.toContain("DO_NOT_SEND");
    expect(envelope[1][0]![1].exception?.values?.[0]?.value).toBe(crashMessage);
    expect(envelope[1][0]![1].tags).toEqual({ mode: "mcp" });
  });
});
