import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { captureExamples, type CaptureBoundary } from "./capture.js";
import { parsePublication, type PublicationManifest, type SiteManifest } from "./manifest.js";
import { verifyPublication } from "./publication.js";
import { packageName, publicRepository } from "./provenance.js";
import { hash, siteFiles, treeHash, verifySiteArtifact } from "./site-artifact.js";
import { renderSite } from "../../website/site.js";
import { conversations } from "../../website/conversations.js";

const time = "2026-11-15T12:00:00.000Z";
const publication: PublicationManifest = {
  schemaVersion: 1,
  repository: { id: 123, name: publicRepository },
  publisher: {
    workflowId: 10,
    workflowPath: ".github/workflows/publish.yml",
    runId: 20,
    attempt: 1,
    event: "workflow_dispatch",
    ref: "refs/heads/release",
    sourceSha: "a".repeat(40),
  },
  channel: "latest",
  release: {
    package: packageName,
    version: "1.2.3",
    gitHead: "a".repeat(40),
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarball: `https://registry.npmjs.org/${packageName}/-/presidential-daily-briefing-1.2.3.tgz`,
  },
  officialRelease: { id: 30, tag: "v1.2.3", publishedAt: time },
  completed: true,
};
function boundary(): CaptureBoundary & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    now: () => new Date(time),
    sensitiveValues: ["fixture-private-token"],
    controlledPaths: [],
    privateIdentities: [],
    assertBudget: async () => 4,
    snapshot: async () =>
      JSON.stringify({
        schemaVersion: 1,
        repository: publicRepository,
        fetchedAt: time,
        startedAt: time,
        issues: [],
        pullRequests: [],
        dependencies: [],
        changed: [],
        warnings: [],
      }),
    run: async (argv) => {
      calls.push([...argv]);
      const stdout =
        argv[0] === "version"
          ? "pdb 1.2.3\nUpdate check: skipped — disabled\n"
          : argv[0] === "--help"
            ? "--repo --cache --offline --role rules onboard"
            : argv[0] === "rules"
              ? `Policy: rulesHash ${"b".repeat(64)}`
              : argv[0] === "onboard"
                ? "onboard help"
                : "fixture-only briefing output";
      return { code: 0, stdout, stderr: "" };
    },
  };
}

describe("allowlisted example pipeline", () => {
  it("uses one live snapshot and offline role projections with traceable hashes", async () => {
    const b = boundary();
    const result = await captureExamples(publication, b);
    expect(result.examples.map((x) => x.mode)).toEqual([
      "local",
      "local",
      "local",
      "local",
      "live",
      "offline",
      "offline",
    ]);
    expect(b.calls.filter((x) => x.includes("--repo") && !x.includes("--offline"))).toHaveLength(1);
    expect(
      b.calls.some((x) => x.includes("--install") || x.includes("claim") || x.includes("rebrief")),
    ).toBe(false);
    expect(
      result.examples.filter((x) => x.mode !== "local").every((x) => x.observedAt === time),
    ).toBe(true);
    expect(result.examples.every((x) => x.sha256 === hash(x.text))).toBe(true);
    expect(result.policyIdentity).toBe("b".repeat(64));
  });
  it("labels partial snapshots and retains omissions", async () => {
    const b = boundary();
    const run = b.run;
    b.run = async (argv, live) => ({ ...(await run(argv, live)), code: live ? 2 : 0 });
    const snapshot = JSON.parse(await b.snapshot()) as Record<string, unknown>;
    snapshot.warnings = ["Fixture: permission coverage incomplete."];
    b.snapshot = async () => JSON.stringify(snapshot);
    const result = await captureExamples(publication, b);
    for (const example of result.examples.filter((x) => x.mode !== "local")) {
      expect(example.completeness).toBe("partial");
      expect(example.omissions).toContain("Fixture: permission coverage incomplete.");
    }
  });
  it("refuses unsupported released commands, failed output, unsafe output and foreign caches", async () => {
    const noHelp = boundary();
    noHelp.run = async () => ({ code: 0, stdout: "pdb 1.2.3\n", stderr: "" });
    await expect(captureExamples(publication, noHelp)).rejects.toThrow("lacks required");
    const failed = boundary();
    failed.run = async () => ({ code: 1, stdout: "fixture-private-token", stderr: "" });
    await expect(captureExamples(publication, failed)).rejects.toThrow("output discarded");
    const unsafe = boundary();
    const run = unsafe.run;
    unsafe.run = async (argv, live) =>
      live ? { code: 0, stdout: "fixture-private-token", stderr: "" } : run(argv, live);
    await expect(captureExamples(publication, unsafe)).rejects.toThrow("Sensitive output");
    const foreign = boundary();
    foreign.snapshot = async () => JSON.stringify({ repository: "other/private" });
    await expect(captureExamples(publication, foreign)).rejects.toThrow("schema or repository");
  });
});

describe("official publication evidence", () => {
  const facts = (): Record<string, unknown> => ({
    run: {
      id: 20,
      run_attempt: 1,
      workflow_id: 10,
      path: ".github/workflows/publish.yml",
      event: "workflow_dispatch",
      head_branch: "release",
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      repository: { id: 123, full_name: publicRepository },
      head_repository: { id: 123 },
    },
    jobs: {
      total_count: 1,
      jobs: [
        {
          name: "publish",
          status: "completed",
          conclusion: "success",
          steps: [
            { name: "Validate the request", status: "completed", conclusion: "success" },
            { name: "Tag and GitHub release", status: "completed", conclusion: "success" },
          ],
        },
      ],
    },
    release: { id: 30, tag_name: "v1.2.3", draft: false, prerelease: false, published_at: time },
    ref: { object: { type: "commit", sha: "a".repeat(40) } },
  });
  it("requires strict manifest fields and independent official run/release/tag evidence", async () => {
    expect(parsePublication(JSON.stringify(publication))).toEqual(publication);
    expect(() => parsePublication(JSON.stringify({ ...publication, surprise: true }))).toThrow(
      "schema",
    );
    expect(() => parsePublication(JSON.stringify({ ...publication, channel: "next" }))).toThrow(
      "schema",
    );
    const f = facts();
    const read = async (path: string): Promise<unknown> =>
      path.includes("/jobs?")
        ? f.jobs
        : path.includes("/actions/")
          ? f.run
          : path.includes("/releases/")
            ? f.release
            : f.ref;
    await verifyPublication(publication, read);
    const jobs = f.jobs as { jobs: { conclusion: string }[] };
    jobs.jobs[0]!.conclusion = "skipped";
    await expect(verifyPublication(publication, read)).rejects.toThrow("Publisher job");
    jobs.jobs[0]!.conclusion = "success";
    (f.run as Record<string, unknown>).head_repository = { id: 999 };
    await expect(verifyPublication(publication, read)).rejects.toThrow("run evidence mismatch");
  });
});

describe("site artifact handoff", () => {
  it("verifies every rendered release identity and rejects tampering or a manifest mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdb-site-fixture-"));
    try {
      for (const [path, html] of renderSite({
        release: { version: "1.2.3", gitHead: "a".repeat(40), capturedAt: time },
        examples: [],
      })) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), html);
      }
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets/site.css"), "/* fixture */");
      await writeFile(join(root, "assets/copy.js"), "// fixture");
      await mkdir(join(root, "assets/conversations"));
      for (const { file } of conversations)
        await copyFile(
          new URL(`../../website/assets/conversations/${file}`, import.meta.url),
          join(root, "assets/conversations", file),
        );
      const capture = await captureExamples(publication, boundary());
      const files = await siteFiles(root);
      const manifest: SiteManifest = {
        schemaVersion: 1,
        publication,
        docsRunId: 99,
        templateRevision: "a".repeat(40),
        capturedAt: time,
        repository: publicRepository,
        requests: 4,
        graphqlCost: null,
        policyIdentity: capture.policyIdentity,
        configSha256: null,
        examples: capture.examples,
        screenshots: [],
        files,
        artifactSha256: treeHash(files),
      };
      await verifySiteArtifact(root, JSON.stringify(manifest));
      const image = conversations[0].file;
      const imagePath = join(root, "assets/conversations", image);
      await writeFile(imagePath, "substituted image");
      await expect(siteFiles(root)).rejects.toThrow("reviewed source");
      await rm(imagePath);
      await expect(siteFiles(root)).rejects.toThrow("illustration missing");
      await copyFile(
        new URL(`../../website/assets/conversations/${image}`, import.meta.url),
        imagePath,
      );
      const unknownImage = join(root, "assets/conversations/unreviewed.png");
      await writeFile(unknownImage, "unexpected");
      await expect(siteFiles(root)).rejects.toThrow("Unexpected");
      await rm(unknownImage);
      const mismatch = structuredClone(manifest);
      mismatch.templateRevision = "c".repeat(40);
      await expect(verifySiteArtifact(root, JSON.stringify(mismatch))).rejects.toThrow(
        "provenance/hash mismatch",
      );
      await writeFile(join(root, "assets/copy.js"), "// tampered");
      await expect(verifySiteArtifact(root, JSON.stringify(manifest))).rejects.toThrow(
        "file mismatch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
