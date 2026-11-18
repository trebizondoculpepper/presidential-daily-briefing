import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import { execFileTransport } from "./transport.js";
import type { GhCall, GhOutcome } from "./transport.js";
import { AuthenticationError } from "../github.js";

// Synthetic transport answers only; no network and no real gh login.
function fake(answer: (call: GhCall) => GhOutcome) {
  const calls: GhCall[] = [];
  return {
    calls,
    transport: async (call: GhCall) => {
      calls.push(call);
      return answer(call);
    },
  };
}
const ok = (stdout: string): GhOutcome => ({ ok: true, stdout });
const fail = (
  kind: "spawn" | "exit" | "timeout" | "cancelled",
  stderr = "",
  exitCode: number | null = 1,
): GhOutcome => ({
  ok: false,
  kind,
  exitCode,
  stdout: "",
  stderr,
});

describe("typed GH service: account (#869)", () => {
  it("passes literal arguments and validates the login", async () => {
    const t = fake(() => ok(JSON.stringify({ login: "octo-cat", id: 1 })));
    const svc = createGhService({ transport: t.transport, env: {} });
    expect(await svc.account.current()).toEqual({ host: "github.com", login: "octo-cat" });
    expect(t.calls[0]!.args).toEqual(["api", "user"]);
  });

  it("takes the host from the injected environment, isolated per service", async () => {
    const t = fake(() => ok(JSON.stringify({ login: "octo" })));
    const enterprise = createGhService({ transport: t.transport, env: { GH_HOST: "ghe.example" } });
    const plain = createGhService({ transport: t.transport, env: {} });
    expect((await enterprise.account.current()).host).toBe("ghe.example");
    expect((await plain.account.current()).host).toBe("github.com");
    // gh itself runs with the same environment, for both capabilities.
    await enterprise.repos.fromCheckout().catch(() => undefined);
    expect(t.calls.filter((c) => c.env?.GH_HOST === "ghe.example")).toHaveLength(2);
    expect(t.calls[1]!.env).toEqual({});
  });

  it("rejects malformed and login-less responses rather than guessing", async () => {
    const bad = createGhService({ transport: fake(() => ok("not json")).transport, env: {} });
    await expect(bad.account.current()).rejects.toThrow(/unreadable/);
    const none = createGhService({ transport: fake(() => ok("{}")).transport, env: {} });
    await expect(none.account.current()).rejects.toThrow(/no login/);
    const odd = createGhService({
      transport: fake(() => ok('{"login":"a b"}')).transport,
      env: {},
    });
    await expect(odd.account.current()).rejects.toThrow(/no login/);
  });

  it("classifies authentication failures and keeps others generic", async () => {
    const auth = createGhService({
      transport: fake(() => fail("exit", "HTTP 401: Bad credentials")).transport,
      env: {},
    });
    await expect(auth.account.current()).rejects.toBeInstanceOf(AuthenticationError);
    for (const kind of ["spawn", "timeout", "exit"] as const) {
      const svc = createGhService({ transport: fake(() => fail(kind, "boom")).transport, env: {} });
      const error = (await svc.account.current().then(
        () => new Error("unexpected success"),
        (e: unknown) => e as Error,
      )) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AuthenticationError);
      // Subprocess stderr is never echoed to the application.
      expect(error.message).not.toContain("boom");
    }
  });

  it("rejects with the caller's abort reason when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller gone"));
    const svc = createGhService({
      transport: fake(() => fail("cancelled", "", null)).transport,
      env: {},
    });
    await expect(svc.account.current(controller.signal)).rejects.toThrow("caller gone");
  });
});

describe("typed GH service: repository of a checkout (#869)", () => {
  it("passes the checkout as cwd and validates owner/name", async () => {
    const t = fake(() => ok("octo/project\n"));
    const svc = createGhService({ transport: t.transport, env: {} });
    expect(await svc.repos.fromCheckout("/work/project")).toBe("octo/project");
    expect(t.calls[0]).toMatchObject({
      args: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      cwd: "/work/project",
    });
  });

  it("refuses an unusable answer or a failure with the same guidance", async () => {
    for (const outcome of [ok(""), ok("not a repo"), fail("exit", "no remotes")]) {
      const svc = createGhService({ transport: fake(() => outcome).transport, env: {} });
      await expect(svc.repos.fromCheckout()).rejects.toThrow(/Supply --repo owner\/name/);
    }
  });
});

describe("GH transport (#869)", () => {
  it.skipIf(process.platform === "win32")(
    "runs gh without a shell and distinguishes success, exit, spawn failure and cancellation",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pdb-gh-transport-"));
      const path = process.env.PATH;
      try {
        // A stand-in gh that echoes its literal arguments, or fails, or waits.
        await writeFile(
          join(dir, "gh"),
          '#!/bin/sh\ncase "$1" in\n  ok) printf "%s|" "$@";;\n  host) printf "%s" "$GH_HOST";;\n  fail) echo partial; echo "HTTP 401" >&2; exit 4;;\n  wait) exec sleep 30;;\nesac\n',
          { mode: 0o700 },
        );
        process.env.PATH = `${dir}:${path}`;
        const base = { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 };
        // A shell metacharacter stays one literal argument.
        expect(await execFileTransport({ ...base, args: ["ok", "a; echo pwned"] })).toEqual({
          ok: true,
          stdout: "ok|a; echo pwned|",
        });
        // The environment reaches gh: the stand-in echoes GH_HOST when asked.
        expect(
          await execFileTransport({
            ...base,
            args: ["host"],
            env: { ...process.env, GH_HOST: "ghe.example" },
          }),
        ).toEqual({ ok: true, stdout: "ghe.example" });
        expect(await execFileTransport({ ...base, args: ["fail"] })).toMatchObject({
          ok: false,
          kind: "exit",
          exitCode: 4,
          stdout: "partial\n",
          stderr: "HTTP 401\n",
        });
        const controller = new AbortController();
        const running = execFileTransport({ ...base, args: ["wait"], signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        expect(await running).toMatchObject({ ok: false, kind: "cancelled" });
        expect(await execFileTransport({ ...base, args: ["wait"], timeoutMs: 100 })).toMatchObject({
          ok: false,
          kind: "timeout",
        });
        process.env.PATH = dir.replace(/[^/]+$/, "pdb-no-such-dir");
        expect(await execFileTransport({ ...base, args: ["ok"] })).toMatchObject({
          ok: false,
          kind: "spawn",
        });
      } finally {
        process.env.PATH = path;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
