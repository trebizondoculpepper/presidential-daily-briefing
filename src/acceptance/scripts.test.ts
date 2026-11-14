import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

// The installed-bin check (#11) runs against the real packed archive in
// scripts/package-test.ts (npm run package-test), which builds first and runs in every CI job.
describe("release versions (doc/npm-releases.md)", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  it("follows the contract's sequence: 0.0.x-next before 0.1.0, patch per main build, minor per release", async () => {
    const { chooseVersion } = await import("../../scripts/release-version.js");
    const history: { version: string; gitHead: string }[] = [];
    const step = (channel: "next" | "latest", n: number) => {
      const { version } = chooseVersion({ channel, sha: sha(n), published: history });
      history.push({ version: version!, gitHead: sha(n) });
      return version;
    };
    expect([step("next", 1), step("next", 2)]).toEqual(["0.0.1-next.1", "0.0.2-next.1"]);
    expect(step("latest", 3)).toBe("0.1.0");
    expect([step("next", 4), step("next", 5)]).toEqual(["0.1.1-next.1", "0.1.2-next.1"]);
    expect(step("latest", 6)).toBe("0.2.0");
    expect(step("next", 7)).toBe("0.2.1-next.1");
  });
  it("recognises a commit already published on the channel instead of assigning another version", async () => {
    const { chooseVersion } = await import("../../scripts/release-version.js");
    const published = [{ version: "0.0.1-next.1", gitHead: sha(1) }];
    expect(chooseVersion({ channel: "next", sha: sha(1), published })).toMatchObject({
      version: null,
      alreadyPublished: "0.0.1-next.1",
    });
    // The same commit may still be promoted to an official release.
    expect(chooseVersion({ channel: "latest", sha: sha(1), published }).version).toBe("0.1.0");
  });
  it("moves to the following prerelease after a registry-lag conflict, never bumping a release", async () => {
    const { followingPrerelease } = await import("../../scripts/release-version.js");
    expect(followingPrerelease("0.1.1-next.1")).toBe("0.1.2-next.1");
    expect(followingPrerelease("0.0.9-next.1")).toBe("0.0.10-next.1");
    expect(() => followingPrerelease("0.1.0")).toThrow();
  });
  it("orders prereleases before their release and ignores unrelated versions", async () => {
    const { chooseVersion, compare, parse } = await import("../../scripts/release-version.js");
    expect(compare(parse("0.1.0-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(compare(parse("0.0.9-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(parse("1.0.0-beta.1")).toBeNull();
    const published = [{ version: "1.0.0-beta.1" }, { version: "0.3.0" }];
    expect(chooseVersion({ channel: "next", sha: sha(9), published }).version).toBe("0.3.1-next.1");
  });
});

describe("explicit publication helpers (#79)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  type Fake = {
    main?: string;
    release?: string | null;
    ancestor?: (x: string, y: string) => boolean;
    dispatchFails?: boolean;
  };
  const fakeRunner = (f: Fake) => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "rev-parse")
        return args[1] === "origin/main" ? (f.main ?? A) : (f.release ?? "");
      if (cmd === "git" && args[0] === "ls-remote")
        return f.release ? `${f.release}\trefs/heads/release` : "";
      if (cmd === "git" && args[0] === "merge-base") {
        if (!(f.ancestor ?? (() => true))(args[2], args[3])) throw new Error("not ancestor");
        return "";
      }
      if (cmd === "gh" && f.dispatchFails) throw new Error("dispatch failed");
      return "";
    };
    return { run, calls };
  };
  it("make-prerelease resolves main once and dispatches channel=next on main with that SHA", async () => {
    const { makePrerelease } = await import("../../scripts/dispatch.js");
    const f = fakeRunner({ main: A });
    makePrerelease({}, f.run);
    expect(f.calls).toEqual([
      "git fetch --no-tags origin main",
      "git rev-parse origin/main",
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
  });
  it("release fast-forwards release, then dispatches channel=latest on release; never forces", async () => {
    const { release } = await import("../../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B });
    const lines = release({}, f.run);
    expect(f.calls.filter((c) => c.startsWith("git push") || c.startsWith("gh"))).toEqual([
      `git push origin ${A}:refs/heads/release`,
      `gh workflow run publish.yml --ref release -f channel=latest -f sha=${A}`,
    ]);
    expect(f.calls.some((c) => c.includes("--force"))).toBe(false);
    expect(lines[0]).toMatch(/publishes nothing/);
    const already = fakeRunner({ main: A, release: A });
    release({}, already.run);
    expect(already.calls.some((c) => c.startsWith("git push"))).toBe(false);
  });
  it("refuses to rewrite release history", async () => {
    const { release } = await import("../../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, ancestor: (x) => x !== B });
    expect(() => release({}, f.run)).toThrow(/refusing to rewrite release history/);
    expect(f.calls.some((c) => c.startsWith("git push") || c.startsWith("gh"))).toBe(false);
  });
  it("reports a failed dispatch with a retry for the same SHA, and retries never re-resolve main", async () => {
    const { release, makePrerelease } = await import("../../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, dispatchFails: true });
    expect(() => release({}, f.run)).toThrow(
      new RegExp(`Promoted ${A}.*npm run release -- --sha ${A}`),
    );
    const retry = fakeRunner({ main: B, release: A });
    makePrerelease({ sha: A }, retry.run);
    expect(retry.calls).toEqual([
      "git fetch --no-tags origin main",
      `git merge-base --is-ancestor ${A} origin/main`,
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
    const offMain = fakeRunner({ ancestor: () => false });
    expect(() => makePrerelease({ sha: A }, offMain.run)).toThrow(/not on origin\/main/);
  });
  it("validates arguments", async () => {
    const { parseArgs } = await import("../../scripts/dispatch.js");
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--sha", A])).toEqual({ sha: A });
    for (const bad of [["--sha", "abc"], ["--sha"], ["--sha", A, "x"], ["--force"]])
      expect(() => parseArgs(bad)).toThrow();
  });
  it("the Publish workflow runs only on explicit dispatch and validates before building", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
    const validate = workflow.indexOf("Validate the request");
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(workflow.indexOf("npm ci"));
    expect(workflow).toContain('"$GITHUB_SHA" != "$SHA"');
    expect(workflow).toContain("next:main|latest:release");
    // A queued request re-checks the live branch head right before publishing.
    const live = workflow.indexOf('git ls-remote origin "refs/heads/$GITHUB_REF_NAME"');
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(workflow.indexOf("npm publish --provenance"));
  });
});
