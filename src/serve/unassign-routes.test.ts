import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startServe, type RunningServer } from "../serve.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";
import { dashboardRenderers } from "./dashboard.js";
import { humanRenderers } from "./human-page.js";
import type { Query } from "../github/github.js";
import type { ServeRuntime } from "./types.js";

const REPO = "example/project";
const CLAIM_START = "2026-11-18T10:00:00Z";

function makeRuntime(opts?: {
  permission?: "allow" | "deny" | "unknown";
  onWrite?: (args: string[]) => void;
}): ServeRuntime {
  let labels = ["agent:kavya", "status:in-progress", "impact:M"];
  const comments: {
    id: string;
    body: string;
    createdAt: string;
    author: { __typename: string; login: string };
  }[] = [];
  const query: Query = (async (q: string) => {
    if (q.includes("timelineItems") && !q.includes("labels(")) {
      return {
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasPreviousPage: false, startCursor: null },
              nodes: [
                {
                  __typename: "LabeledEvent",
                  createdAt: CLAIM_START,
                  label: { name: "agent:kavya" },
                },
              ],
            },
          },
        },
      };
    }
    if (q.includes("comments(") && !q.includes("labels(")) {
      return {
        repository: {
          issueOrPullRequest: {
            comments: {
              pageInfo: { hasPreviousPage: false, startCursor: null },
              nodes: comments,
            },
          },
        },
      };
    }
    return {
      repository: {
        claims: { pageInfo: { hasNextPage: false }, nodes: [] },
        issueOrPullRequest: {
          __typename: "Issue",
          number: 42,
          title: "Stalled task",
          body: "Needs attention",
          url: "https://github.com/example/project/issues/42",
          state: "OPEN",
          createdAt: "2026-11-18T09:00:00Z",
          updatedAt: "2026-11-18T10:05:00Z",
          lastEditedAt: null,
          labels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: labels.map((name) => ({ name })),
          },
          assignees: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { __typename: "User", login: "alice" },
              { __typename: "User", login: "bob" },
            ],
          },
          issueDependenciesSummary: { blockedBy: 0 },
          blockedBy: { nodes: [] },
          comments: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: null,
            },
            nodes: comments,
          },
          timelineItems: {
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              {
                __typename: "LabeledEvent",
                createdAt: CLAIM_START,
                label: { name: "agent:kavya" },
              },
            ],
          },
          closedByPullRequestsReferences: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    };
  }) as Query;

  const permState = opts?.permission ?? "allow";
  return {
    currentRepository: async () => REPO,
    authContext: async () => ({ host: "github.com", login: "alice" }),
    clock: {
      now: () => new Date("2026-11-19T00:00:00Z"),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    stdout: () => {},
    stderr: () => {},
    signals: new EventEmitter(),
    exit: () => {},
    version: async () => "0.1.0-test",
    platform: "linux",
    unassign: {
      query,
      permission: () => async (login: string) => {
        if (login !== "alice") throw new Error(`unexpected permission login: ${login}`);
        return permState === "allow" ? "write" : permState === "deny" ? "read" : "unknown";
      },
      run: async (args) => {
        opts?.onWrite?.(args);
        if (args[1] === "comment") {
          const idx = args.indexOf("--body");
          comments.push({
            id: `c-${comments.length + 1}`,
            body: args[idx + 1] ?? "",
            createdAt: "2026-11-19T00:01:00Z",
            author: { __typename: "User", login: "alice" },
          });
        } else if (args[1] === "edit") {
          labels = labels.filter((l) => l !== "agent:kavya");
        }
        return;
      },
    },
  };
}

const servers: RunningServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function startTestServer(
  allowEdits: boolean,
  opts?: { permission?: "allow" | "deny" | "unknown"; onWrite?: (args: string[]) => void },
) {
  const serve = makeRuntime(opts);
  const options = {
    port: 0,
    host: "127.0.0.1",
    allowRemote: false,
    allowEdits,
    ttlMs: 300_000,
    repos: [REPO],
    projects: [],
  };
  const read = {
    collect: async () => ({
      items: [],
      warnings: [],
      diagnostics: { incomplete: [] },
    }),
    dependencyReport: async () => ({}),
    now: () => serve.clock.now(),
    env: {},
  };
  const running = await startServe(options, serve, readServices(options, serve, read as never));
  servers.push(running);
  return running;
}

describe("serve human-unassign routes and UI (#588)", () => {
  it("disables unassign routes and omits Unassign UI by default", async () => {
    const srv = await startTestServer(false);
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const page = await fetch(`${baseUrl}/human?repo=${encodeURIComponent(REPO)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-allow-edits="false"');
    expect(html).not.toContain('id="unassign-dialog"');

    const sess = await fetch(`${baseUrl}/api/v1/session`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(sess.status).toBe(403);
    expect((await sess.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "EDITS_DISABLED" },
    });
  });

  it("enforces Origin, CSRF, JSON and permission guards and executes preview + idempotent apply", async () => {
    const writes: string[][] = [];
    const srv = await startTestServer(true, { onWrite: (args) => writes.push(args) });
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const page = await fetch(`${baseUrl}/human?repo=${encodeURIComponent(REPO)}`);
    const html = await page.text();
    expect(html).toContain('data-allow-edits="true"');
    expect(html).toContain('id="unassign-dialog"');

    // Without CSRF cookie/header -> 403 CSRF_REQUIRED before any GitHub access.
    const noCsrf = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign/preview?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify({ agent: "kavya" }),
      },
    );
    expect(noCsrf.status).toBe(403);
    expect(writes).toHaveLength(0);

    // Bootstrap same-origin CSRF session.
    const sess = await fetch(`${baseUrl}/api/v1/session`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(sess.status).toBe(200);
    const cookie = sess.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("pdb_write_session=");
    const { csrfToken } = (await sess.json()) as { csrfToken: string };

    // Unknown request field rejected cleanly before GitHub access.
    const badField = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign/preview?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          cookie,
          "x-pdb-csrf": csrfToken,
        },
        body: JSON.stringify({ agent: "kavya", extra: true }),
      },
    );
    expect(badField.status).toBe(400);

    // Preview succeeds and returns claimStart + revision + preserved assignees.
    const previewRes = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign/preview?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          cookie,
          "x-pdb-csrf": csrfToken,
        },
        body: JSON.stringify({ agent: "kavya" }),
      },
    );
    expect(previewRes.status).toBe(200);
    const { preview } = (await previewRes.json()) as {
      preview: {
        claimStart: string;
        revision: string;
        preserved: { humanAssignees: string[] };
      };
    };
    expect(preview.preserved.humanAssignees).toEqual(["alice", "bob"]);

    // Apply with valid operationId, actor, claimStart and revision.
    const applyRes = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          cookie,
          "x-pdb-csrf": csrfToken,
        },
        body: JSON.stringify({
          operationId: "op-http-1",
          actor: "alice",
          agent: "kavya",
          expectedClaimStart: preview.claimStart,
          expectedRevision: preview.revision,
        }),
      },
    );
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as {
      status: string;
      preserved: { humanAssignees: string[]; labels: string[] };
    };
    expect(applied.status).toBe("applied");
    expect(applied.preserved.humanAssignees).toEqual(["alice", "bob"]);
    expect(applied.preserved.labels).toEqual(["status:in-progress", "impact:M"]);
    expect(writes).toHaveLength(2);

    // Duplicate delivery with same operationId + intent coalesces cleanly without extra writes.
    const dupRes = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          cookie,
          "x-pdb-csrf": csrfToken,
        },
        body: JSON.stringify({
          operationId: "op-http-1",
          actor: "alice",
          agent: "kavya",
          expectedClaimStart: preview.claimStart,
          expectedRevision: preview.revision,
        }),
      },
    );
    expect(dupRes.status).toBe(200);
    expect(writes).toHaveLength(2);

    // Reusing same operationId with different intent -> 409 CONFLICT.
    const conflictRes = await fetch(
      `${baseUrl}/api/v1/tickets/42/unassign?repo=${encodeURIComponent(REPO)}`,
      {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          cookie,
          "x-pdb-csrf": csrfToken,
        },
        body: JSON.stringify({
          operationId: "op-http-1",
          actor: "bob",
          agent: "kavya",
          expectedClaimStart: preview.claimStart,
          expectedRevision: preview.revision,
        }),
      },
    );
    expect(conflictRes.status).toBe(409);
  });

  it("renders Unassign button in humanRenderers only when allowEdits is true", () => {
    const view = humanRenderers(dashboardRenderers());
    const envelope = {
      status: "complete",
      selection: { repository: REPO },
      result: {
        human: {
          total: 1,
          omitted: 0,
          items: [
            {
              target: `https://github.com/${REPO}/issues/42`,
              source: `https://github.com/${REPO}/issues/42`,
              title: "Stalled task",
              kind: "decide",
              explicit: true,
              attentionSection: "actionable",
              reason: "Needs decision",
              raisedBy: ["old_questioner"],
              claims: ["kavya"],
              routedTo: ["alice"],
              requested: [],
              blocks: { subjects: [], unknown: [] },
              warnings: [],
              ruleIds: ["R-1"],
              nextCommand: "pdb --issue 42",
            },
          ],
        },
      },
    };
    const readonlyHtml = view.renderSections(envelope, 50, false).actionable;
    expect(readonlyHtml).not.toContain("unassign-btn");

    const editableHtml = view.renderSections(envelope, 50, true).actionable;
    expect(editableHtml).toContain('class="unassign-btn"');
    expect(editableHtml).toContain('data-issue="42"');
    expect(editableHtml).toContain('data-agent="kavya"');
    expect(editableHtml).toContain("Unassign kavya");
    expect(editableHtml).not.toContain("Unassign old_questioner");
  });

  it("refuses --allow-edits combined with --allow-remote", () => {
    expect(() => serveArguments(["--host", "0.0.0.0", "--allow-remote", "--allow-edits"])).toThrow(
      /allow-edits/,
    );
  });
});
