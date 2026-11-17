import { describe, it, expect, afterEach } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOne, printEdn } from "../edn.js";
import {
  parseProjectSource,
  readProjectSource,
  ProjectSourceError,
  projectRulesFile,
  sourceLimits,
} from "./source.js";
import type { ProjectSourceIO } from "./source.js";
const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = {
  policyVersion: 1,
  rulesHash: "811a2953071e3e54c081245f1b3b15f661cc7cb7a883e1b2c4f893d613195ba0",
};
const parse = (text: string) => parseProjectSource(text, base);
const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "pdb-project-source-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProjectSourceError) return e.code;
    throw e;
  }
  return "no-error";
};
describe("project source boundary (#514, parsing stage only)", () => {
  it("preserves opaque native bodies without claiming semantic validation or execution", () => {
    const value = parse(fixture);
    expect(value).toMatchObject({
      phase: "parsed-source",
      formatVersion: 1,
      projectionVersion: 1,
      basePolicyVersion: 1,
      baseRulesHash: base.rulesHash,
    });
    expect(value.rules).toHaveLength(1);
    expect(value.preferences).toHaveLength(1);
    expect(value.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toHaveProperty("effectiveRulesHash");
    // This phase must never be mistaken for the full native compiler.
    expect(parse(fixture.replace("project-hotfix", "unsafe-unchecked-name")).phase).toBe(
      "parsed-source",
    );
  });
  it("canonicalizes map order/comments but retains ordered native clauses", () => {
    const form = readOne(fixture, "fixture") as { map: unknown[][] };
    const reversed = printEdn({ map: [...form.map].reverse() }, "reversed");
    expect(parse(`; comment\n${reversed}`).sourceDigest).toBe(parse(fixture).sourceDigest);
    expect(parse(fixture.replace("(+ 0 10)", "(+ 0 11)")).sourceDigest).not.toBe(
      parse(fixture).sourceDigest,
    );
  });
  it.each([
    ["version", fixture.replace(":format-version 1", ":format-version 3"), "source-version"],
    [
      "projection",
      fixture.replace(":projection-version 1", ":projection-version 2"),
      "source-version",
    ],
    [
      "policy",
      fixture.replace(":base-policy-version 1", ":base-policy-version 2"),
      "base-mismatch",
    ],
    ["hash", fixture.replace(base.rulesHash, "0".repeat(64)), "base-mismatch"],
    ["missing", fixture.replace(":projection-version 1", ""), "missing-key"],
    ["unknown", fixture.replace(":format-version", ":unknown-version"), "source-key"],
    ["root", "[]", "source-map"],
    ["vectors", fixture.replace(":rules [", ":rules ("), "invalid-edn"],
    [
      "duplicate",
      fixture.replace(":format-version 1", ":format-version 1 :format-version 1"),
      "duplicate-key",
    ],
    [
      "nested duplicate",
      fixture.replace(':witnesses {"label"', ':witnesses {"label" [] "label"'),
      "duplicate-key",
    ],
    ["second form", `${fixture} []`, "invalid-edn"],
    ["native character", "\\[", "unsupported-edn"],
  ])("rejects %s without accepting a partial policy", (_name, text, expected) => {
    expect(code(() => parse(text))).toBe(expected);
  });
  it("bounds UTF-8 bytes before parsing, with exact boundary and non-ASCII input", () => {
    const fill = sourceLimits.bytes - Buffer.byteLength(fixture) - 2;
    expect(parse(`${fixture};${"x".repeat(fill)}\n`).sourceDigest).toBe(
      parse(fixture).sourceDigest,
    );
    expect(code(() => parse(`${fixture};${"x".repeat(fill + 1)}\n`))).toBe("source-bytes");
    expect(code(() => parse(`${fixture};${"é".repeat(sourceLimits.bytes / 2)}`))).toBe(
      "source-bytes",
    );
  });
  it("bounds recursive parser depth, including after CR-only comments", () => {
    const deep = "[".repeat(21) + "]".repeat(21);
    expect(code(() => parse(deep))).toBe("source-depth");
    expect(code(() => parse(`;comment\r${deep}`))).toBe("source-depth");
    expect(parse(fixture.replace("Project priority label matched:", "[".repeat(30))).phase).toBe(
      "parsed-source",
    );
  });
  it("bounds nodes and source-vector counts independently", () => {
    const header = `{:format-version 1 :projection-version 1 :base-policy-version 1 :base-rules-hash "${base.rulesHash}"`;
    expect(code(() => parse(`${header} :rules [[${"0 ".repeat(10000)}]] :preferences []}`))).toBe(
      "source-nodes",
    );
    expect(code(() => parse(`${header} :rules [${"[] ".repeat(101)}] :preferences []}`))).toBe(
      "source-count",
    );
    expect(code(() => parse(`${header} :rules [] :preferences [${"{} ".repeat(51)}]}`))).toBe(
      "source-count",
    );
  });
  it("rejects unsupported native values and bad supplied base identity", () => {
    expect(code(() => parse(fixture.replace("(+ 0 10)", "(+ 0 nil)")))).toBe("unsupported-edn");
    expect(
      code(() => parseProjectSource(fixture, { policyVersion: 1, rulesHash: "not-a-hash" })),
    ).toBe("base-identity");
  });
  it("reads only the fixed file within an explicitly selected root", async () => {
    const root = await temp();
    await writeFile(join(root, projectRulesFile), fixture);
    expect((await readProjectSource(root, base)).sourceDigest).toBe(parse(fixture).sourceDigest);
  });
  it("rejects nonabsolute roots before any filesystem access", async () => {
    let calls = 0;
    const io: ProjectSourceIO = {
      realpath: async () => {
        calls++;
        return "/";
      },
      read: async () => {
        calls++;
        return new Uint8Array();
      },
    };
    await expect(readProjectSource("relative", base, io)).rejects.toMatchObject({
      code: "project-root",
    });
    expect(calls).toBe(0);
  });
  it("rejects root escapes and sibling-prefix tricks before reading", async () => {
    const root = await temp();
    let reads = 0;
    const io: ProjectSourceIO = {
      realpath: async (p) => (p === root ? root : `${root}-outside/${projectRulesFile}`),
      read: async () => {
        reads++;
        return Buffer.from(fixture);
      },
    };
    await expect(readProjectSource(root, base, io)).rejects.toMatchObject({
      code: "source-escape",
    });
    expect(reads).toBe(0);
  });
  it("enforces growth/encoding bounds from the injected reader and sanitizes I/O failures", async () => {
    const root = await temp();
    const io: ProjectSourceIO = {
      realpath: async (p) => p,
      read: async () => Buffer.alloc(sourceLimits.bytes + 1),
    };
    await expect(readProjectSource(root, base, io)).rejects.toMatchObject({ code: "source-bytes" });
    io.read = async () => new Uint8Array([0xc3, 0x28]);
    await expect(readProjectSource(root, base, io)).rejects.toMatchObject({
      code: "source-encoding",
    });
    io.read = async () => {
      throw Error("PRIVATE TOKEN CONTENT");
    };
    await expect(readProjectSource(root, base, io)).rejects.toThrow(
      "Cannot read selected project source",
    );
    await expect(readProjectSource(root, base, io)).rejects.not.toThrow("PRIVATE TOKEN");
  });
  it("rejects missing, oversized and non-regular real files", async () => {
    const root = await temp();
    await expect(readProjectSource(root, base)).rejects.toMatchObject({
      code: "source-unreadable",
    });
    await writeFile(join(root, projectRulesFile), Buffer.alloc(sourceLimits.bytes + 1));
    await expect(readProjectSource(root, base)).rejects.toMatchObject({ code: "source-bytes" });
    await rm(join(root, projectRulesFile));
    await mkdir(join(root, projectRulesFile));
    await expect(readProjectSource(root, base)).rejects.toMatchObject({
      code: expect.stringMatching(/^source-(file|unreadable)$/),
    });
  });
  it.skipIf(process.platform === "win32")(
    "refuses a named pipe without waiting for a writer",
    async () => {
      const root = await temp();
      const made = spawnSync("mkfifo", [join(root, projectRulesFile)], { timeout: 2000 });
      expect(made.error).toBeUndefined();
      expect(made.status).toBe(0);
      // Isolate a regressed blocking open in a killable child, not this test worker's pool.
      const script = `
      const { readProjectSource } = await import(process.env.PDB_SOURCE_ENTRY);
      try {
        await readProjectSource(process.env.PDB_FIFO_ROOT, {policyVersion:1,rulesHash:process.env.PDB_BASE_HASH});
        process.exitCode = 1;
      } catch (error) {
        if (error.code !== "source-file") throw error;
      }
    `;
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          timeout: 5000,
          env: {
            ...process.env,
            PDB_SOURCE_ENTRY: new URL("./source.ts", import.meta.url).href,
            PDB_FIFO_ROOT: root,
            PDB_BASE_HASH: base.rulesHash,
          },
          encoding: "utf8",
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    },
  );
  it.skipIf(process.platform === "win32")(
    "allows internal symlinks but refuses an escaping symlink",
    async () => {
      const root = await temp(),
        outside = await temp();
      await writeFile(join(root, "internal.edn"), fixture);
      await symlink(join(root, "internal.edn"), join(root, projectRulesFile));
      expect((await readProjectSource(root, base)).sourceDigest).toBe(parse(fixture).sourceDigest);
      await rm(join(root, projectRulesFile));
      await writeFile(join(outside, "outside.edn"), fixture);
      await symlink(join(outside, "outside.edn"), join(root, projectRulesFile));
      await expect(readProjectSource(root, base)).rejects.toMatchObject({ code: "source-escape" });
    },
  );
});
