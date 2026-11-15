import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { installRelease } from "./install.js";
import { isolatedEnvironment } from "./environment.js";
import { runProcess } from "./process.js";
import { packageName, type ReleaseIdentity } from "./provenance.js";
import { createHash } from "node:crypto";

describe.skipIf(process.platform === "win32")("offline fixture artifact installation", () => {
  it("installs verified bytes, disables lifecycle scripts and executes only the installed fixture binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-fixture-install-"));
    try {
      const env = { ...(await isolatedEnvironment(root)), npm_config_offline: "true" };
      const fixture = join(root, "fixture");
      await mkdir(join(fixture, "dist"), { recursive: true });
      await writeFile(
        join(fixture, "dist/cli.mjs"),
        'process.stdout.write("pdb fixture-artifact\\n");',
      );
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify({
          name: packageName,
          version: "1.2.3",
          gitHead: "a".repeat(40),
          bin: { pdb: "dist/cli.mjs" },
          files: ["dist"],
          scripts: {
            preinstall: "node -e \"require('node:fs').writeFileSync('hook-ran','bad')\"",
          },
        }),
      );
      const packed = await runProcess({
        file: "npm",
        argv: ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
        cwd: fixture,
        env,
        timeoutMs: 30_000,
      });
      expect(packed.code).toBe(0);
      const pack = JSON.parse(packed.stdout) as { filename: string }[];
      const bytes = await readFile(join(root, pack[0]!.filename));
      const release: ReleaseIdentity = {
        package: packageName,
        version: "1.2.3",
        gitHead: "a".repeat(40),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        tarball: `https://registry.npmjs.org/${packageName}/-/fixture.tgz`,
      };
      const cli = await installRelease(release, {
        root,
        env,
        run: runProcess,
        download: async () => bytes,
      });
      await expect(access(join(dirname(dirname(cli)), "hook-ran"))).rejects.toThrow();
      const result = await runProcess({
        file: process.execPath,
        argv: [cli],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      expect(result.stdout).toBe("pdb fixture-artifact\n");
      await expect(
        installRelease(
          { ...release, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
          {
            root,
            env,
            run: async () => {
              throw new Error("installer must not run");
            },
            download: async () => bytes,
          },
        ),
      ).rejects.toThrow("integrity mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
