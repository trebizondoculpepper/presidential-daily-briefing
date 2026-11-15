/**
 * Test-only preload for the packaged crash-frame checks (#629, scripts/package-test.ts). It is
 * never shipped (package.json "files") and never imported by PDB. Node runs it directly
 * (type stripping), so no loader is added to the installed process.
 *
 * - Replaces `https.request` with a local recorder: an envelope addressed to the test DSN host
 *   is written, decompressed, to PDB_CRASH_CAPTURE; any other HTTPS request fails, so the
 *   check can never reach Sentry or any other network service.
 * - Throws from `process.stderr.write` when the text matches PDB_CRASH_TRIGGER, or from the
 *   first `process.exit` call when PDB_CRASH_TRIGGER is `exit`. PDB's own
 *   event-listener code calls that write outside any try block, so the throw is a genuine
 *   unhandled exception whose stack runs through the installed bundle.
 */
import https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";

const capture = process.env.PDB_CRASH_CAPTURE;
const trigger = new RegExp(process.env.PDB_CRASH_TRIGGER ?? "(?!)");

type Respond = (response: IncomingMessage) => void;
const recorder = (options: RequestOptions, respond: Respond): ClientRequest => {
  if (options?.hostname !== "sentry.example.invalid")
    throw new Error("crash-preload: refused a network request");
  const chunks: Buffer[] = [];
  const request = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
    final(done) {
      let body = Buffer.concat(chunks);
      if ((options.headers as Record<string, unknown> | undefined)?.["content-encoding"] === "gzip")
        body = gunzipSync(body);
      if (capture) appendFileSync(capture, `${body.toString("utf8")}\n\u0000\n`);
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: {},
        setEncoding() {},
      });
      respond(response as unknown as IncomingMessage);
      response.emit("end");
      done();
    },
  });
  return Object.assign(request, { reusedSocket: false }) as unknown as ClientRequest;
};
(https as { request: unknown }).request = recorder;
syncBuiltinESMExports();

// PDB_CRASH_TRIGGER=exit: the first process.exit call throws instead (later ones, including
// the SDK's own exit after reporting, behave normally).
if (process.env.PDB_CRASH_TRIGGER === "exit") {
  const exit = process.exit.bind(process);
  process.exit = (() => {
    process.exit = exit;
    throw new Error("DO_NOT_SEND private payload /Users/private/secret-token ghp_notreal");
  }) as typeof process.exit;
}
// Readiness for the MCP check: PDB registers its SIGTERM handler only once polling is bound.
const once = process.once.bind(process);
process.once = ((event: string, listener: (...args: unknown[]) => void) => {
  const result = once(event, listener);
  if (event === "SIGTERM") process.stderr.write("crash-preload: SIGTERM handler registered\n");
  return result;
}) as typeof process.once;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  if (trigger.test(String(chunk)))
    throw new Error("DO_NOT_SEND private payload /Users/private/secret-token ghp_notreal");
  return write(chunk, ...rest);
}) as typeof process.stderr.write;
