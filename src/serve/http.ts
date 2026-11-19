/**
 * HTTP plumbing for `pdb serve` (doc/design/serve.md "HTTP surface" and "Security"): the
 * DNS-rebinding guard, JSON responses with the size guard, and bounded JSON request bodies.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { MAX_BODY_BYTES } from "./options.js";

/** Largest JSON response body; larger results answer 500 RESULT_TOO_LARGE instead. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Stable error codes of the JSON API (doc/design/serve.md, error table). */
export type ServeErrorCode =
  | "INVALID_ARGUMENT"
  | "REPOSITORY_UNRESOLVED"
  | "REPOSITORY_NOT_SERVED"
  | "FORBIDDEN_ORIGIN"
  | "MISDIRECTED_HOST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CACHE_INVALIDATED"
  | "CONTEXT_CHANGED"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_AUTH"
  | "GITHUB_RATE_LIMITED"
  | "SHUTTING_DOWN"
  | "INTERNAL"
  | "RESULT_TOO_LARGE"
  | "DIAGNOSTIC_CURSOR_EXPIRED"
  | "RUNS_BUSY"
  | "RUN_TIMEOUT"
  | "PROJECT_REQUIRED"
  | "EDITS_DISABLED"
  | "CSRF_REQUIRED"
  | "CONFLICT";

export interface ServeError {
  code: ServeErrorCode;
  message: string;
  next: string[];
  /** #346: a safe, structured engine cause (validated fields only), when one is known. */
  cause?: { category: "missing-module"; module: string | null; recovery: string[] };
}

/** An HTTP failure carried to the router, which renders the error envelope. */
export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ServeErrorCode,
    message: string,
    readonly next: string[] = [],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Host names as they appear in a Host or Origin header (IPv6 in brackets). */
const headerName = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);

/**
 * Host names a request may address: the loopback names, plus the bound address. A
 * non-loopback address is only ever bound with --allow-remote, so adding it is the contract's
 * "with --allow-remote the explicit --host value is added".
 */
export function allowedHostnames(boundHost: string): string[] {
  return [...new Set(["localhost", "127.0.0.1", "[::1]", headerName(boundHost)])];
}

const portOf = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80));

/**
 * The DNS-rebinding guard, applied before routing to every route including /mcp. The SDK
 * validators compare host names only, so the bound port (and, for Origin, the http scheme) is
 * checked here too: a page served by another local program on another port must not pass.
 */
export function guardRequest(
  headers: IncomingMessage["headers"],
  allowed: string[],
  port: number,
): HttpFailure | null {
  const host = headers.host;
  const hostCheck = validateHostHeader(host, allowed);
  if (!hostCheck.ok || portOf(new URL(`http://${host}`)) !== port)
    return new HttpFailure(
      421,
      "MISDIRECTED_HOST",
      "The Host header does not name this server. Use the URL printed at startup.",
    );
  const origin = headers.origin;
  if (origin !== undefined) {
    const originCheck = validateOriginHeader(origin, allowed);
    let sameServer = false;
    if (originCheck.ok) {
      const url = new URL(origin);
      sameServer = url.protocol === "http:" && portOf(url) === port;
    }
    if (!sameServer)
      return new HttpFailure(403, "FORBIDDEN_ORIGIN", "Cross-origin requests are not accepted.");
  }
  return null;
}

/** Serialize and send one JSON response; never caches, never streams unbounded data. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): number {
  let text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    status = 500;
    text = JSON.stringify(
      errorDocument({
        code: "RESULT_TOO_LARGE",
        message: `The result exceeds the ${MAX_RESPONSE_BYTES}-byte response limit.`,
        next: ["Use the CLI with --json for this read."],
      }),
    );
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(text);
  return status;
}

/** Error document for routes outside the data envelope (unknown route, guard failures). */
export function errorDocument(error: ServeError) {
  return { schemaVersion: 1, kind: "serve-error", status: "error", error } as const;
}

/** True when the request declares a JSON body (`application/json`, any parameters). */
export function isJsonRequest(headers: IncomingMessage["headers"]): boolean {
  const type = headers["content-type"];
  return (
    typeof type === "string" && type.split(";")[0]!.trim().toLowerCase() === "application/json"
  );
}

/** Read a JSON request body of at most {@link MAX_BODY_BYTES}; empty bodies read as `{}`. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!isJsonRequest(request.headers))
    throw new HttpFailure(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "POST requests must send Content-Type: application/json.",
    );
  const tooLarge = () =>
    new HttpFailure(
      413,
      "BODY_TOO_LARGE",
      `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`,
      [],
      { connection: "close" },
    );
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    throw tooLarge();
  }
  // Event-based so an oversized body is discarded as it arrives (never buffered) while the
  // socket stays usable for the 413 answer.
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const received: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        received.length = 0;
        reject(tooLarge());
      } else received.push(chunk);
    });
    request.on("end", () => resolve(received));
    request.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpFailure(400, "INVALID_ARGUMENT", "The request body is not valid JSON.");
  }
}
