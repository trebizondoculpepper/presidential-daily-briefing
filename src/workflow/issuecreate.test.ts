import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import type { Rest, RestAnswer } from "../github/github.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { ghPostWith } from "../github/service/issues.js";
import {
  createIssue,
  defaultReadFile,
  MAX_BODY_BYTES,
  readStdinBounded,
  creationMarker,
  intentDigest,
  ISSUE_CREATE_MARKER,
  issueCreateExitCode,
} from "./issuecreate.js";
import type { IssueCreateRequest, IssueCreateRuntime, PostAnswer } from "./issuecreate.js";

const target = "owner/repo";
const repoBody = (over: Record<string, unknown> = {}) => ({
  full_name: target,
  id: 42,
  node_id: "R_kgDO42",
  html_url: `https://github.com/${target}`,
  archived: false,
  has_issues: true,
  permissions: { admin: false, push: true, triage: true, pull: true },
  ...over,
});
const issueBody = (number: number, labels: string[], over: Record<string, unknown> = {}) => ({
  number,
  node_id: `I_${number}`,
  html_url: `https://github.com/${target}/issues/${number}`,
  repository_url: `https://api.github.com/repos/${target}`,
  labels: labels.map((name) => ({ name })),
  assignees: [{ login: "reporter" }],
  ...over,
});

interface Fake {
  rt: IssueCreateRuntime;
  posts: {
    path: string;
    payload: { title: string; body: string; labels?: string[]; assignees?: string[] };
  }[];
  gets: string[];
  stderr: string[];
}
function fake(
  options: {
    repo?: RestAnswer;
    labels?: Record<string, number>;
    post?: (n: number) => PostAnswer | Promise<PostAnswer>;
    readBack?: RestAnswer;
    current?: () => Promise<string>;
    stdin?: string;
    files?: Record<string, string>;
    targetContext?: IssueCreateRuntime["targetContext"];
    employingHuman?: IssueCreateRuntime["employingHuman"];
  } = {},
): Fake {
  const posts: Fake["posts"] = [];
  const gets: string[] = [];
  const stderr: string[] = [];
  const rest: Rest = async (path) => {
    gets.push(path);
    if (path === `repos/${target}` || path === "repos/other/name")
      return options.repo ?? { status: 200, body: repoBody() };
    if (path === "user") return { status: 200, body: { login: "reporter" } };
    const label = /\/labels\/(.+)$/.exec(path);
    if (label) {
      const name = decodeURIComponent(label[1]!);
      return { status: options.labels?.[name] ?? 200, body: { name } };
    }
    if (/\/issues\/\d+$/.test(path)) return options.readBack ?? { status: 500, body: null };
    return { status: 404, body: null };
  };
  const rt: IssueCreateRuntime = {
    rest,
    post: async (path, payload) => {
      posts.push({ path, payload: payload as Fake["posts"][number]["payload"] });
      if (options.post) return options.post(posts.length);
      const typed = payload as { labels?: string[]; assignees?: string[] };
      return {
        dispatched: true,
        status: 201,
        body: issueBody(100 + posts.length, typed.labels ?? [], {
          assignees: (typed.assignees ?? []).map((login) => ({ login })),
        }),
      };
    },
    currentRepository: options.current ?? (async () => target),
    now: () => new Date("2026-11-15T12:00:00Z"),
    operationId: (() => {
      let n = 0;
      return () => `op${String(++n).padStart(14, "0")}`;
    })(),
    readFile: async (path) => {
      const text = options.files?.[path];
      if (text === undefined) throw new Error(`ENOENT secret ${path}`);
      return Buffer.from(text);
    },
    readStdin: async () => Buffer.from(options.stdin ?? ""),
    stderr: (t) => stderr.push(t),
    targetContext:
      options.targetContext ?? (async (repository) => ({ verified: true, repository })),
    ...(options.employingHuman ? { employingHuman: options.employingHuman } : {}),
  };
  return { rt, posts, gets, stderr };
}
const request = (over: Partial<IssueCreateRequest> = {}): IssueCreateRequest => ({
  title: "A bug",
  labels: [],
  dryRun: false,
  json: true,
  ...over,
});

describe("issue create: targeting", () => {
  it("defaults to the current checkout and shows the resolved target before writing", async () => {
    const f = fake();
    const result = await createIssue(request({ json: false }), f.rt);
    expect(result.status).toBe("created");
    expect(result.target).toMatchObject({ repository: target, nodeId: "R_kgDO42" });
    expect(f.posts.map((p) => p.path)).toEqual([`repos/${target}/issues`]);
    expect(f.stderr.join("")).toContain(`creating in ${target} (R_kgDO42)`);
    expect(result.issue).toEqual({
      number: 101,
      nodeId: "I_101",
      url: `https://github.com/${target}/issues/101`,
    });
    expect(issueCreateExitCode(result)).toBe(0);
  });
  it("uses an explicit --repo without consulting the checkout", async () => {
    let asked = false;
    const f = fake({
      repo: { status: 200, body: repoBody({ full_name: "other/name" }) },
      current: async () => {
        asked = true;
        return target;
      },
    });
    const result = await createIssue(request({ repo: "other/name" }), f.rt);
    expect(asked).toBe(false);
    expect(f.posts[0]!.path).toBe("repos/other/name/issues");
    // The response URL is in owner/repo, not other/name: never reported as created.
    expect(result.status).toBe("unknown");
    expect(result.issue).toBeNull();
    expect(f.posts).toHaveLength(1);
  });
  it("fails with guidance outside a checkout instead of guessing", async () => {
    const f = fake({
      current: async () => {
        throw new Error("Cannot resolve repository. Supply --repo owner/name");
      },
    });
    await expect(createIssue(request(), f.rt)).rejects.toThrow("--repo");
    expect(f.posts).toHaveLength(0);
  });
  it("refuses a redirect to a different canonical repository", async () => {
    const f = fake({ repo: { status: 200, body: repoBody({ full_name: "new/home" }) } });
    const result = await createIssue(request(), f.rt);
    expect(result).toMatchObject({ status: "refused", error: { id: "TARGET_REDIRECTED" } });
    expect(f.posts).toHaveLength(0);
  });
  it("refuses inaccessible, archived and issue-disabled repositories", async () => {
    for (const [answer, id] of [
      [{ status: 404, body: { message: "Not Found" } }, "INACCESSIBLE"],
      [{ status: 200, body: repoBody({ archived: true }) }, "ARCHIVED"],
      [{ status: 200, body: repoBody({ has_issues: false }) }, "ISSUES_DISABLED"],
    ] as const) {
      const f = fake({ repo: answer });
      const result = await createIssue(request(), f.rt);
      expect(result.error?.id).toBe(id);
      expect(issueCreateExitCode(result)).toBe(1);
      expect(f.posts).toHaveLength(0);
    }
  });
  it("stops on a rate-limited read without dispatching", async () => {
    const f = fake({
      repo: {
        status: 403,
        body: null,
        evidence: {
          category: "rate-limited",
          quotaEvidence: "exhausted",
          errorTypes: [],
          httpStatus: 403,
          observation: {} as never,
        },
      },
    });
    const result = await createIssue(request(), f.rt);
    expect(result.error?.id).toBe("QUOTA");
    expect(f.posts).toHaveLength(0);
  });
});

describe("issue create: permissions and labels", () => {
  it("lets a reporter without write access create an issue", async () => {
    const f = fake({
      repo: { status: 200, body: repoBody({ permissions: { push: false, pull: true } }) },
    });
    expect((await createIssue(request(), f.rt)).status).toBe("created");
  });
  it("reports a definitive permission refusal as refused, not unknown", async () => {
    const f = fake({ post: () => ({ dispatched: true, status: 403, body: null }) });
    const result = await createIssue(request(), f.rt);
    expect(result).toMatchObject({ status: "refused", error: { id: "PERMISSION" } });
    expect(f.posts).toHaveLength(1);
  });
  it("refuses a missing label instead of creating it", async () => {
    const f = fake({ labels: { "typo-bug": 404 } });
    const result = await createIssue(request({ labels: ["bug", "typo-bug"] }), f.rt);
    expect(result).toMatchObject({ status: "refused", error: { id: "LABEL_MISSING" } });
    expect(f.posts).toHaveLength(0);
  });
  it("reports dropped labels as partial with the real URL and no second create", async () => {
    const f = fake({
      repo: { status: 200, body: repoBody({ permissions: { push: false } }) },
      post: () => ({ dispatched: true, status: 201, body: issueBody(7, []) }),
      readBack: { status: 200, body: issueBody(7, []) },
    });
    const result = await createIssue(request({ labels: ["bug"] }), f.rt);
    expect(result.status).toBe("partial");
    expect(result.issue?.url).toBe(`https://github.com/${target}/issues/7`);
    expect(result.labels).toEqual({ requested: ["bug"], applied: [] });
    expect(result.warnings.join(" ")).toContain("lacks push access");
    expect(issueCreateExitCode(result)).toBe(2);
    expect(f.posts).toHaveLength(1);
  });
  it("validates and deduplicates labels before any request", async () => {
    const f = fake();
    const result = await createIssue(request({ labels: ["Bug", "bug", " docs "] }), f.rt);
    expect(result.labels.requested).toEqual(["Bug", "docs"]);
    await expect(createIssue(request({ labels: [""] }), f.rt)).rejects.toThrow("Invalid --label");
    await expect(
      createIssue(request({ labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }), f.rt),
    ).rejects.toThrow("At most 20");
  });
});

describe("issue create: retries and honest outcomes", () => {
  it("an uncertain reply is unknown; a retry finds no duplicate made automatically", async () => {
    const f = fake({
      post: (n) =>
        n === 1
          ? { dispatched: true, status: null, body: null, timedOut: true }
          : { dispatched: true, status: 201, body: issueBody(9, []) },
    });
    const first = await createIssue(request(), f.rt);
    expect(first.status).toBe("unknown");
    expect(issueCreateExitCode(first)).toBe(2);
    expect(f.posts).toHaveLength(1);
    expect(first.recovery.join("\n")).toContain(first.operationId);
    expect(first.recovery.join("\n")).toContain("Do not re-run");
    // A 5xx and a malformed 201 are also unknown and also exactly one POST each.
    for (const answer of [
      { dispatched: true, status: 502, body: null },
      { dispatched: true, status: 201, body: { number: "x" } },
      { dispatched: true, status: 201, body: { ...issueBody(3, []), pull_request: {} } },
    ]) {
      const g = fake({ post: () => answer });
      expect((await createIssue(request(), g.rt)).status).toBe("unknown");
      expect(g.posts).toHaveLength(1);
    }
    // A not-dispatched failure is refused, never unknown.
    const h = fake({ post: () => ({ dispatched: false, status: null, body: null }) });
    expect((await createIssue(request(), h.rt)).error?.id).toBe("NOT_DISPATCHED");
  });
  it("binds the marker to operation, target and intent without copying private text", async () => {
    const f = fake();
    await createIssue(request({ body: "secret details" }), f.rt);
    const body = f.posts[0]!.payload.body;
    expect(body.startsWith("secret details\n\n<!-- " + ISSUE_CREATE_MARKER)).toBe(true);
    const marker = body.slice(body.indexOf("<!--"));
    expect(marker).toBe(
      creationMarker({
        operationId: "op00000000000001",
        repository: target,
        repositoryId: "R_kgDO42",
        digest: intentDigest("A bug", "secret details", [], ["reporter"]),
      }),
    );
    expect(marker).not.toContain("secret");
  });
});

describe("issue create: input safety", () => {
  it("passes untrusted title and body as data", async () => {
    const f = fake({ files: { "body.md": '$(rm -rf /) `id` "quoted" -->' } });
    const title = "'; rm -rf / #\" $(id) `whoami` --> ${HOME}";
    const result = await createIssue(request({ title, bodyFile: "body.md" }), f.rt);
    expect(result.status).toBe("created");
    expect(f.posts[0]!.payload.title).toBe(title);
    expect(f.posts[0]!.payload.body.startsWith('$(rm -rf /) `id` "quoted" -->\n\n')).toBe(true);
  });
  it("reads the body from stdin with -", async () => {
    const f = fake({ stdin: "from stdin" });
    await createIssue(request({ bodyFile: "-" }), f.rt);
    expect(f.posts[0]!.payload.body.startsWith("from stdin\n\n")).toBe(true);
  });
  it("rejects bad input before any request and never echoes file contents", async () => {
    const f = fake({ files: { big: "x".repeat(70_000) } });
    await expect(createIssue(request({ title: "  " }), f.rt)).rejects.toThrow("empty");
    await expect(createIssue(request({ title: "a\nb" }), f.rt)).rejects.toThrow("one line");
    await expect(createIssue(request({ title: "x".repeat(257) }), f.rt)).rejects.toThrow("256");
    await expect(createIssue(request({ body: "a", bodyFile: "-" }), f.rt)).rejects.toThrow(
      "not both",
    );
    await expect(createIssue(request({ bodyFile: "big" }), f.rt)).rejects.toThrow("exceeds");
    const missing = createIssue(request({ bodyFile: "nope" }), f.rt);
    await expect(missing).rejects.toThrow("Cannot read --body-file.");
    await expect(createIssue(request({ repo: "bad" }), f.rt)).rejects.toThrow("owner/name");
    expect(f.gets).toHaveLength(0);
    expect(f.posts).toHaveLength(0);
  });
  it("dry-run resolves and previews with zero writes", async () => {
    const f = fake();
    const result = await createIssue(request({ dryRun: true, body: "b", labels: ["bug"] }), f.rt);
    expect(result.status).toBe("planned");
    expect(result.preview?.body).toContain(ISSUE_CREATE_MARKER);
    expect(result.target?.repository).toBe(target);
    expect(f.posts).toHaveLength(0);
    expect(issueCreateExitCode(result)).toBe(0);
  });
});

describe("pdb issue create CLI", () => {
  it("prints help without a checkout or login", async () => {
    let out = "";
    const code = await main(
      ["issue", "create", "--help", "--no-update-check"],
      async (t) => {
        out += t;
      },
      {
        collect: () => Promise.reject(new Error("no")),
        currentRepository: () => Promise.reject(new Error("no")),
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("Usage: pdb issue create");
  });
  it("emits exactly one JSON document and never touches local configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    try {
      await mkdir(join(dir, ".github"));
      const files = [join(dir, "pdb.toml"), join(dir, ".github", "triage.toml")];
      for (const file of files) await writeFile(file, "# untouched\n");
      const before = await Promise.all(files.map((f) => stat(f)));
      const f = fake();
      let out = "";
      const code = await main(
        ["issue", "create", "--title", "T", "--repo", target, "--json", "--no-update-check"],
        async (t) => {
          out += t;
        },
        {
          collect: () => Promise.reject(new Error("no")),
          currentRepository: () => Promise.reject(new Error("no")),
          rest: f.rt.rest,
          issueCreate: { ...f.rt },
          stderr: () => {},
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        schemaVersion: 1,
        kind: "issue-create",
        status: "created",
      });
      for (const [i, file] of files.entries()) {
        expect(await readFile(file, "utf8")).toBe("# untouched\n");
        expect((await stat(file)).mtimeMs).toBe(before[i]!.mtimeMs);
      }
      expect(f.stderr).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("issue create: unverified labels and bounded input", () => {
  it("keeps applied labels unknown when the reply lacks them and read-back fails", async () => {
    const f = fake({
      post: () => ({
        dispatched: true,
        status: 201,
        body: { ...issueBody(8, []), labels: undefined },
      }),
    });
    const result = await createIssue(request({ labels: ["bug"] }), f.rt);
    expect(result.labels.applied).toBeNull();
    expect(result).toMatchObject({ status: "partial", error: { id: "LABELS_UNVERIFIED" } });
    expect(result.issue?.number).toBe(8);
    expect(result.recovery).toEqual([]);
    expect(f.posts).toHaveLength(1);
  });
  it("refuses an oversize body file by size and reads a small one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-body-"));
    try {
      const big = join(dir, "big.md");
      const small = join(dir, "small.md");
      await writeFile(big, Buffer.alloc(MAX_BODY_BYTES + 1, 120));
      await writeFile(small, "hello");
      await expect(defaultReadFile(big)).rejects.toThrow("exceeds");
      expect(Buffer.from(await defaultReadFile(small)).toString()).toBe("hello");
      const f = fake();
      f.rt.readFile = defaultReadFile;
      await expect(createIssue(request({ bodyFile: big }), f.rt)).rejects.toThrow("exceeds");
      expect(f.gets).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("stops reading stdin once past the limit", async () => {
    let pulled = 0;
    async function* endless() {
      for (;;) {
        pulled++;
        yield Buffer.alloc(16 * 1024, 120);
      }
    }
    await expect(readStdinBounded(endless())).rejects.toThrow("exceeds");
    expect(pulled).toBe(5);
    async function* small() {
      yield Buffer.from("ok");
    }
    expect(Buffer.from(await readStdinBounded(small())).toString()).toBe("ok");
  });
});

describe("issue create: generated commands and the create boundary", () => {
  it.skipIf(process.platform === "win32")(
    "quotes untrusted label text in recovery commands so a shell treats it as data",
    async () => {
      const hostile = ["$(touch pwned)", "`id`", 'it\'s "q"', "a b;c|d&e", "bug,docs"];
      const f = fake({
        post: () => ({ dispatched: true, status: 201, body: issueBody(7, []) }),
        readBack: { status: 200, body: issueBody(7, []) },
      });
      const result = await createIssue(request({ labels: hostile }), f.rt);
      expect(result.status).toBe("partial");
      expect(result.recovery).toHaveLength(1);
      // A stand-in gh prints its arguments and stdin: the shell must pass both through intact.
      const out = execFileSync(
        "sh",
        ["-c", `gh() { printf '%s\\n' "$@"; cat; }\n${result.recovery[0]!}`],
        { encoding: "utf8" },
      ).split("\n");
      expect(out.slice(0, 6)).toEqual([
        "api",
        "--method",
        "POST",
        `repos/${target}/issues/7/labels`,
        "--input",
        "-",
      ]);
      expect(JSON.parse(out[6]!)).toEqual({ labels: hostile });
      // Newlines never reach a command: labels with control characters are rejected first.
      await expect(createIssue(request({ labels: ["a\nb"] }), f.rt)).rejects.toThrow(
        "Invalid --label",
      );
    },
  );
  it.skipIf(process.platform === "win32")(
    "quotes the unknown-outcome recovery query as separate arguments",
    async () => {
      const f = fake({ post: () => ({ dispatched: true, status: 503, body: null }) });
      const result = await createIssue(request(), f.rt);
      const parsed = execFileSync(
        "sh",
        ["-c", `set -- ${result.recovery[0]!}; printf '%s\\n' "$#" "$3"`],
        { encoding: "utf8" },
      ).split("\n");
      expect(parsed[0]).toBe("5");
      expect(parsed[1]).toContain(`repos/${target}/issues?creator=reporter&since=`);
    },
  );
  it("survives gh closing stdin early (EPIPE) and never reports created", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new Writable({
        write: (_c, _e, done) => done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
        final: (done) => done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      });
      child.stdout = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.emit("spawn");
        setImmediate(() => {
          child.stdout.end();
          child.emit("close", 1);
        });
      });
      return child;
    }) as never;
    const answer = await ghPostWith(fakeSpawn)("repos/owner/repo/issues", { title: "t" });
    expect(answer).toMatchObject({ dispatched: true, status: null });
    const f = fake({ post: () => answer });
    const result = await createIssue(request(), f.rt);
    expect(result.status).toBe("unknown");
    expect(result.issue).toBeNull();
  });
});

describe("issue create: human ownership and verified context (#666, #674)", () => {
  it("assigns the resolved employing human by default in the one POST without creating an agent claim", async () => {
    const f = fake({
      employingHuman: async () => ({
        state: "current",
        host: "github.com",
        login: "alice",
        source: "gh-login",
        observedAt: "2026-11-15T12:00:00Z",
      }),
      targetContext: async (repository) => ({
        verified: true,
        repository,
        defaultLabels: ["triage:managed"],
      }),
    });
    const result = await createIssue(request({ agent: "agent_one", labels: ["bug"] }), f.rt);
    expect(result.status).toBe("created");
    expect(result.assignees).toEqual({ requested: ["alice"], applied: ["alice"] });
    expect(result.labels).toEqual({
      requested: ["triage:managed", "bug"],
      applied: ["triage:managed", "bug"],
    });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.payload.assignees).toEqual(["alice"]);
    expect(f.posts[0]!.payload.labels).toEqual(["triage:managed", "bug"]);
    expect(f.posts[0]!.payload.labels).not.toContain("status:claimed");
  });

  it("supports separate-human creation intent via explicit assignees and distinct digest", async () => {
    const f = fake();
    const dry = await createIssue(request({ dryRun: true, assignees: ["bob"] }), f.rt);
    expect(dry.status).toBe("planned");
    expect(dry.assignees).toEqual({ requested: ["bob"], applied: null });
    expect(dry.preview?.body).toContain(intentDigest("A bug", "", [], ["bob"]));
    expect(dry.preview?.body).not.toContain(intentDigest("A bug", "", [], ["reporter"]));
    expect(f.posts).toHaveLength(0);

    const created = await createIssue(request({ assignees: ["bob"] }), f.rt);
    expect(created.status).toBe("created");
    expect(created.assignees).toEqual({ requested: ["bob"], applied: ["bob"] });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.payload.assignees).toEqual(["bob"]);
  });

  it("reports partial with recovery and real issue link when GitHub omits assignment, never retrying POST", async () => {
    const f = fake({
      post: () => ({
        dispatched: true,
        status: 201,
        body: issueBody(101, [], { assignees: [] }),
      }),
      readBack: { status: 200, body: issueBody(101, [], { assignees: [] }) },
    });
    const result = await createIssue(request(), f.rt);
    expect(result.status).toBe("partial");
    expect(result.error?.id).toBe("ASSIGNMENT_MISSING");
    expect(result.issue?.url).toBe(`https://github.com/${target}/issues/101`);
    expect(result.assignees).toEqual({ requested: ["reporter"], applied: [] });
    expect(result.recovery.join("\n")).toContain(`repos/${target}/issues/101/assignees`);
    expect(f.posts).toHaveLength(1);
    expect(issueCreateExitCode(result)).toBe(2);
  });

  it("reports partial when assignee outcome is unreadable after failed read-back, never retrying POST", async () => {
    const f = fake({
      post: () => ({
        dispatched: true,
        status: 201,
        body: {
          number: 101,
          node_id: "I_101",
          html_url: `https://github.com/${target}/issues/101`,
        },
      }),
      readBack: { status: 500, body: null },
    });
    const result = await createIssue(request(), f.rt);
    expect(result.status).toBe("partial");
    expect(result.error?.id).toBe("ASSIGNMENT_UNVERIFIED");
    expect(result.issue?.url).toBe(`https://github.com/${target}/issues/101`);
    expect(result.assignees).toEqual({ requested: ["reporter"], applied: null });
    expect(f.posts).toHaveLength(1);
    expect(issueCreateExitCode(result)).toBe(2);
  });

  it("refuses unverified or unmanaged target context with ordinary gh guidance and zero POSTs", async () => {
    const f = fake({
      targetContext: async () => ({
        verified: false,
        reason: "No PDB policy configuration (.github/triage.toml) found.",
      }),
    });
    const result = await createIssue(
      request({ title: "Outside bug", body: "secret body text", labels: ["bug"] }),
      f.rt,
    );
    expect(result.status).toBe("refused");
    expect(result.error?.id).toBe("UNVERIFIED_TARGET_CONTEXT");
    expect(result.recovery[0]).toContain("gh issue create");
    expect(result.recovery[0]).toContain(target);
    expect(result.recovery[0]).not.toContain("secret body text");
    expect(f.posts).toHaveLength(0);
    expect(issueCreateExitCode(result)).toBe(1);
  });
});
