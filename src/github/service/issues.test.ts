import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { Rest } from "../github.js";

describe("typed GH service: issues (#887)", () => {
  it("validates repository metadata, viewer login, label existence, create dispatch, and read-back", async () => {
    const rest: Rest = async (path) => {
      if (path === "repos/o/r")
        return {
          status: 200,
          body: {
            full_name: "o/r",
            id: 7,
            node_id: "R_7",
            html_url: "https://github.com/o/r",
            archived: false,
            has_issues: true,
            permissions: { push: true },
          },
        };
      if (path === "user") return { status: 200, body: { login: "alice" } };
      if (path === "repos/o/r/labels/bug") return { status: 200, body: { name: "bug" } };
      if (path === "repos/o/r/labels/missing") return { status: 404, body: null };
      if (path === "repos/o/r/issues/12")
        return {
          status: 200,
          body: {
            node_id: "I_12",
            labels: [{ name: "bug" }],
            assignees: [{ login: "alice" }],
          },
        };
      return { status: 500, body: null };
    };
    const posts: { path: string; payload: unknown }[] = [];
    const gh = createGhService({
      rest,
      post: async (path, payload) => {
        posts.push({ path, payload });
        return {
          dispatched: true,
          status: 201,
          body: {
            number: 12,
            node_id: "I_12",
            html_url: "https://github.com/o/r/issues/12",
            repository_url: "https://api.github.com/repos/o/r",
            labels: [{ name: "bug" }],
            assignees: [{ login: "alice" }],
          },
        };
      },
    });

    const repo = await gh.issues.readRepository("o/r");
    expect(repo).toEqual({
      ok: true,
      value: {
        fullName: "o/r",
        id: 7,
        nodeId: "R_7",
        url: "https://github.com/o/r",
        archived: false,
        hasIssues: true,
        pushPermission: true,
      },
    });
    expect(await gh.issues.readViewer()).toEqual({ ok: true, value: "alice" });
    expect(await gh.issues.hasLabel("o/r", "bug")).toEqual({ ok: true, value: true });
    expect(await gh.issues.hasLabel("o/r", "missing")).toEqual({ ok: true, value: false });

    const created = await gh.issues.create("o/r", {
      title: "T",
      body: "B",
      labels: ["bug"],
      assignees: ["alice"],
    });
    expect(created).toEqual({
      kind: "created",
      issue: {
        number: 12,
        nodeId: "I_12",
        url: "https://github.com/o/r/issues/12",
        labels: ["bug"],
        assignees: ["alice"],
      },
    });
    expect(posts).toHaveLength(1);

    expect(await gh.issues.readBack("o/r", 12, "I_12")).toEqual({
      labels: ["bug"],
      assignees: ["alice"],
    });
    expect(await gh.issues.readBack("o/r", 12, "WRONG_NODE")).toBeNull();
  });

  it("reports unverified repository identity and failed reads without throwing", async () => {
    const gh = createGhService({
      rest: async (path) =>
        path === "repos/o/bad"
          ? { status: 200, body: { full_name: "not-a-repo" } }
          : { status: 401, body: null },
    });
    expect(await gh.issues.readRepository("o/bad")).toEqual({
      ok: false,
      status: 200,
      unverified: true,
    });
    expect(await gh.issues.readViewer()).toEqual({ ok: false, status: 401 });
  });

  it("routes issues.create through the injected transport, validates outcomes, and honours cancellation", async () => {
    const calls: { args: readonly string[]; stdin?: string }[] = [];
    const gh = createGhService({
      transport: async (call) => {
        calls.push({ args: call.args, stdin: call.stdin });
        if (call.args.includes("repos/o/malformed/issues")) {
          return {
            ok: true,
            stdout: "HTTP/2.0 201 Created\r\n\r\n" + JSON.stringify({ number: 1 }),
          };
        }
        if (call.args.includes("repos/o/mismatch/issues")) {
          return {
            ok: true,
            stdout:
              "HTTP/2.0 201 Created\r\n\r\n" +
              JSON.stringify({
                number: 9,
                node_id: "I_9",
                html_url: "https://github.com/other/repo/issues/9",
                repository_url: "https://api.github.com/repos/other/repo",
              }),
          };
        }
        if (call.args.includes("repos/o/refused/issues")) {
          return {
            ok: false,
            kind: "exit",
            exitCode: 1,
            stdout: 'HTTP/2.0 422 Unprocessable Entity\r\n\r\n{"message":"Validation Failed"}',
            stderr: "",
          };
        }
        return {
          ok: true,
          stdout:
            "HTTP/2.0 201 Created\r\n\r\n" +
            JSON.stringify({
              number: 42,
              node_id: "I_42",
              html_url: "https://github.com/o/r/issues/42",
              repository_url: "https://api.github.com/repos/o/r",
            }),
        };
      },
    });

    const controller = new AbortController();
    controller.abort();
    expect(await gh.issues.create("o/r", { title: "T", body: "B" }, controller.signal)).toEqual({
      kind: "not-dispatched",
      cancelled: true,
    });
    expect(calls).toHaveLength(0);

    expect(await gh.issues.create("o/r", { title: "T", body: "B" })).toEqual({
      kind: "created",
      issue: {
        number: 42,
        nodeId: "I_42",
        url: "https://github.com/o/r/issues/42",
        labels: null,
        assignees: null,
      },
    });
    expect(calls[0]?.args).toEqual([
      "api",
      "--include",
      "--method",
      "POST",
      "repos/o/r/issues",
      "--input",
      "-",
    ]);
    expect(calls[0]?.stdin).toBe(JSON.stringify({ title: "T", body: "B" }));

    expect(await gh.issues.create("o/malformed", { title: "T", body: "B" })).toEqual({
      kind: "unknown",
      reason: "malformed",
      status: 201,
    });
    expect(await gh.issues.create("o/mismatch", { title: "T", body: "B" })).toEqual({
      kind: "unknown",
      reason: "target-mismatch",
      status: 201,
      mismatchedUrl: "https://github.com/other/repo/issues/9",
    });
    expect(await gh.issues.create("o/refused", { title: "T", body: "B" })).toMatchObject({
      kind: "refused",
      status: 422,
    });
  });
});
