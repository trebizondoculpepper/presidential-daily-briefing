import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { createGhTransport, isolatedEnvironment } from "./environment.js";
import { runProcess } from "./process.js";

// The live capture host is POSIX; policy, manifest, renderer and process fixtures run on Windows too.
describe.skipIf(process.platform === "win32")("compiled capture transport", () => {
  it("isolates config and forwards a real query through the compiled proxy with one shared reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-site-transport-"));
    try {
      const env = await isolatedEnvironment(root);
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.HOME).toBe(join(root, "home"));
      expect(env.SHELL).toBeUndefined();
      const fake = join(root, "fake-gh");
      await writeFile(
        fake,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
      const transport = await createGhTransport({
        root,
        source: process.cwd(),
        realGh: fake,
        token: "fixture-only-token",
        initialRequests: 3,
        env,
        run: runProcess,
      });
      const argv = [
        "api",
        "graphql",
        "--include",
        "-f",
        "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner} pdbReadRate:rateLimit{cost}}",
        "-f",
        "owner=trebizondoculpepper",
        "-f",
        "name=presidential-daily-briefing",
      ];
      const request = {
        file: join(root, "bin/gh"),
        argv,
        cwd: root,
        env: { ...transport.env, PDB_SITE_GH_ALLOWED: "1" },
        timeoutMs: 5000,
      };
      const result = await runProcess(request);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(argv);
      expect(JSON.parse(await readFile(transport.budgetPath, "utf8"))).toMatchObject({
        requests: 4,
        refused: false,
      });
      const refused = await runProcess({
        ...request,
        env: { ...transport.env, PDB_SITE_GH_ALLOWED: "0" },
      });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).not.toContain("fixture-only-token");
      expect(JSON.parse(await readFile(transport.budgetPath, "utf8"))).toMatchObject({
        requests: 4,
        refused: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
