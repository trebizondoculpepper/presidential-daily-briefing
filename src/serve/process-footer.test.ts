import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { startServe } from "../serve.js";
import { serveArguments } from "./options.js";
import { shellContext } from "./shell.js";
import type { ServeRuntime } from "./types.js";
import {
  captureProcessIdentity,
  packageBuildIdentity,
  publicIpLiteral,
  renderProcessIdentity,
  withProcessIdentity,
} from "./process-footer.js";

const sha = "a".repeat(40);
const startedAt = new Date("2026-11-17T01:00:00.000Z");

describe("running process identity footer (#730)", () => {
  it("uses installed package provenance without treating a source checkout or missing data as clean", () => {
    expect(packageBuildIdentity({ gitHead: sha }, true)).toMatchObject({
      revision: sha,
      dirty: null,
      source: "package-githead",
    });
    for (const [manifest, installed] of [
      [{ gitHead: sha }, false],
      [{ gitHead: "bad" }, true],
      [null, true],
    ] as const)
      expect(packageBuildIdentity(manifest, installed)).toMatchObject({
        revision: null,
        dirty: null,
        source: "unknown",
      });
  });

  it("keeps a primitive startup snapshot and escapes version text while preserving page safety text", () => {
    const facts = { version: '<img src=x onerror="bad">', startedAt: new Date(startedAt) };
    const build = {
      revision: sha,
      dirty: true,
      source: "build-metadata" as const,
      publicIp: "8.8.8.8",
    };
    const identity = captureProcessIdentity(facts, build);
    facts.version = "changed";
    facts.startedAt.setUTCFullYear(2030);
    build.revision = "b".repeat(40);
    const html = withProcessIdentity("<body><footer>Read-only.</footer></body>", identity);
    expect(html).toContain("Read-only.");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain(`title="${sha}"`);
    expect(html).toContain("Dirty build: yes");
    expect(html).toContain('datetime="2026-11-17T01:00:00.000Z"');
    expect(html).toContain("Public IP: 8.8.8.8");
    expect(html.match(/<footer>/g)).toHaveLength(1);
  });

  it("shows honest unknowns and links the shipped Doctor page, including the no-footer fallback", () => {
    const identity = captureProcessIdentity({ version: null, startedAt });
    const html = withProcessIdentity(
      "<body><main>Choose a project</main></body>",
      identity,
      shellContext(
        "quotas",
        [{ repository: "owner/repo" }],
        new URLSearchParams("repo=owner/repo"),
      ),
    );
    expect(html).toContain("PDB unknown");
    expect(html).toContain("Source: unknown");
    expect(html).toContain("Dirty build: unknown");
    expect(html).toContain("Public IP: unavailable");
    expect(html).toContain('href="/diagnostics?repo=owner%2Frepo">Doctor</a>');
    expect(renderProcessIdentity(identity)).not.toContain(">Doctor</a>");
    expect(
      renderProcessIdentity(captureProcessIdentity({ version: "1", startedAt }, { dirty: false })),
    ).toContain("Dirty build: unknown");
  });

  it("does not expose private, loopback, documentation or nonliteral addresses as public IPs", () => {
    for (const value of [
      null,
      "localhost",
      "<script>",
      "127.0.0.1",
      "10.0.0.2",
      "192.168.1.1",
      "100.64.1.2",
      "203.0.113.1",
      "::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(publicIpLiteral(value)).toBeNull();
    expect(publicIpLiteral("8.8.8.8")).toBe("8.8.8.8");
    expect(publicIpLiteral("2001:4860:4860::8888")).toBe("2001:4860:4860::8888");
  });

  it("integrates one unchanged startup identity across project/account/error HTML and status", async () => {
    let now = new Date(startedAt);
    const metadata = {
      revision: sha,
      dirty: false,
      source: "build-metadata" as const,
      publicIp: "8.8.8.8",
    };
    const buildIdentity = vi.fn(async () => metadata);
    const runtime: ServeRuntime = {
      currentRepository: async () => "owner/repo",
      authContext: async () => ({ host: "github.com", login: "test-human" }),
      clock: {
        now: () => new Date(now),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
      stdout: () => undefined,
      stderr: () => undefined,
      signals: new EventEmitter(),
      exit: () => undefined,
      version: async () => "test-version",
      buildIdentity,
      platform: "linux",
    };
    const server = await startServe(
      serveArguments(["--repo", "owner/repo", "--port", "0"]),
      runtime,
    );
    try {
      metadata.revision = "b".repeat(40);
      now = new Date("2027-01-01T00:00:00Z");
      for (const path of [
        "/?repo=owner/repo",
        "/ticket?repo=owner/repo&n=1",
        "/quotas?repo=owner/repo",
        "/setup?repo=owner/repo",
        "/rules?repo=owner/repo",
        "/human?repo=owner/repo",
        "/activity?repo=owner/repo",
        "/?repo=wrong/project",
      ]) {
        const reply = await fetch(new URL(path, server.facts.url));
        const html = await reply.text();
        expect(html, path).toContain('aria-label="Running PDB process"');
        expect(html, path).toContain("PDB test-version");
        expect(html, path).toContain(`title="${sha}"`);
        expect(html, path).toContain('datetime="2026-11-17T01:00:00.000Z"');
        expect(reply.headers.get("content-security-policy"), path).not.toContain("unsafe-inline");
      }
      const status = await (await fetch(new URL("/api/v1/status", server.facts.url))).json();
      expect(status).toMatchObject({
        version: "test-version",
        startedAt: startedAt.toISOString(),
        build: { revision: sha, dirty: false, source: "build-metadata" },
        publicIp: "8.8.8.8",
      });
      expect(buildIdentity).toHaveBeenCalledTimes(1);
      const head = await fetch(new URL("/quotas?repo=owner/repo", server.facts.url), {
        method: "HEAD",
      });
      expect(await head.text()).toBe("");
    } finally {
      await server.close();
    }
  });
});
