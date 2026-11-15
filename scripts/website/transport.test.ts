import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { allowGhRead } from "./gh-policy.js";
import { reserveGhRead } from "./gh-budget.js";
import { runProcess } from "./process.js";

const query =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(first:50){nodes{number}}} pdbReadRate:rateLimit{cost}}";
const args = (source = query): string[] => [
  "api",
  "graphql",
  "--include",
  "-f",
  `query=${source}`,
  "-f",
  "owner=trebizondoculpepper",
  "-f",
  "name=presidential-daily-briefing",
];

describe("capture gh policy", () => {
  it("permits a real read shape and the project's cost witness without rewriting argv", () => {
    const original = args();
    const copy = [...original];
    allowGhRead(original);
    expect(original).toEqual(copy);
    allowGhRead([
      "api",
      "--include",
      "repos/trebizondoculpepper/presidential-daily-briefing/pulls/1",
    ]);
  });
  it("refuses mutations, other repositories, hidden pagination and alternate root access", () => {
    for (const value of [
      args(query.replace("query(", "mutation(")),
      args("query{viewer{login}}"),
      [...args(), "--paginate"],
      ["issue", "close", "1"],
      [...args().slice(0, -1), "name=private-repository"],
      args(
        query.replace(
          "repository(owner:$owner,name:$name)",
          'repository(owner:"other",name:"private")',
        ),
      ),
      args(query + " query { viewer { login } }"),
      ["api", "repos/other/private/issues"],
      ["api", "repos/trebizondoculpepper/presidential-daily-briefing/issues", "-f", "title=write"],
    ])
      expect(() => allowGhRead(value)).toThrow();
  });
});

describe("shared budget", () => {
  it("reserves concurrent reads under one counter and makes any refusal fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-capture-budget-"));
    try {
      const path = join(root, "budget.json");
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          requests: 0,
          deadline: 1000,
          maximum: 2,
          refused: false,
        }),
      );
      const outcomes = await Promise.allSettled(
        [1, 2, 3].map(() => reserveGhRead(path, true, () => 0)),
      );
      expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(2);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        requests: 2,
        refused: true,
      });
      await expect(reserveGhRead(path, true, () => 0)).rejects.toThrow("refused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bounded literal child execution", () => {
  it("preserves shell-looking arguments literally", async () => {
    const arg = "$(echo should-not-run); `echo nope`";
    const result = await runProcess({
      file: process.execPath,
      argv: ["-e", "process.stdout.write(process.argv[1])", arg],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe(arg);
    expect(result.code).toBe(0);
  });
  it("rejects output over the bound and terminates a hung child", async () => {
    await expect(
      runProcess({
        file: process.execPath,
        argv: ["-e", "process.stdout.write('x'.repeat(10000))"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5000,
        maxBytes: 100,
      }),
    ).rejects.toThrow("output limit");
    await expect(
      runProcess({
        file: process.execPath,
        argv: ["-e", "setInterval(()=>{},1000)"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out");
  });
});

it("cancels a live child and never steals an occupied capture lock", async () => {
  const { acquireCaptureLock } = await import("./lock.js");
  const root = await mkdtemp(join(tmpdir(), "pdb-capture-lock-"));
  try {
    const path = join(root, "lock");
    const release = await acquireCaptureLock(path);
    await expect(acquireCaptureLock(path)).rejects.toThrow("Never steal by age");
    await release();
    const again = await acquireCaptureLock(path);
    await again();
    const cancellation = new AbortController();
    const result = runProcess({
      file: process.execPath,
      argv: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      signal: cancellation.signal,
    });
    cancellation.abort();
    await expect(result).rejects.toThrow("cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records an elapsed GitHub deadline as a fatal refusal without reserving a network read", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdb-capture-expired-"));
  try {
    const path = join(root, "budget.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, requests: 2, deadline: 100, maximum: 50, refused: false }),
    );
    await expect(reserveGhRead(path, true, () => 101)).rejects.toThrow("refused");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ requests: 2, refused: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
