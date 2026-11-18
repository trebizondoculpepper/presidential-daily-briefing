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
        return { dispatched: true, status: 201, body: { number: 12, node_id: "I_12" } };
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
    expect(created).toMatchObject({ dispatched: true, status: 201 });
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
});
