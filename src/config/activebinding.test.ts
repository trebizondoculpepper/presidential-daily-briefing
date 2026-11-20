import { describe, expect, it } from "vite-plus/test";
import { activeBinding } from "./activebinding.js";

const context = { root: "/project", repository: "example/project" };
const env = {
  CODEX_VERSION: "0.169.0",
  CODEX_THREAD_ID: "thread-private-a",
  CODEX_SESSION_ID: "root-shared",
};

describe("verified local execution binding (#677)", () => {
  it("reuses one thread across calls without exposing the raw identifier", () => {
    const a = activeBinding({ ...context, env: { ...env, CODEX_TOOL_CALL_ID: "call-one" } });
    const b = activeBinding({ ...context, env: { ...env, CODEX_TOOL_CALL_ID: "call-two" } });
    expect(a).toEqual(b);
    // #1047: the entry is the harness's canonical default; only the key carries the session.
    expect(a?.entry).toBe("codex");
    expect(a?.key).toMatch(/^codex-thread_[a-f0-9]{64}$/);
    expect(JSON.stringify(a)).not.toContain(env.CODEX_THREAD_ID);
    expect(JSON.stringify(a)).not.toContain(env.CODEX_SESSION_ID);
  });
  it("correlates each thread separately but selects the same default entry (#1047)", () => {
    const a = activeBinding({ ...context, env });
    const b = activeBinding({ ...context, env: { ...env, CODEX_THREAD_ID: "thread-private-b" } });
    expect(a?.key).not.toBe(b?.key);
    expect(a?.entry).toBe(b?.entry);
  });
  it("scopes bindings to the repository and checkout", () => {
    const a = activeBinding({ ...context, env });
    expect(activeBinding({ ...context, env, repository: "example/other" })?.key).not.toBe(a?.key);
    expect(activeBinding({ ...context, env, root: "/other-project" })?.key).not.toBe(a?.key);
  });
  it("normalizes Windows root and repository casing", () => {
    expect(
      activeBinding({ root: "C:\\Project", repository: "Example/Project", env, platform: "win32" }),
    ).toEqual(
      activeBinding({ root: "c:\\project", repository: "example/project", env, platform: "win32" }),
    );
  });
  it.each([
    {},
    { CODEX_VERSION: "0.169.0", CODEX_SESSION_ID: "root-shared" },
    { CODEX_THREAD_ID: "thread-a" },
    { CODEX_VERSION: "0.168.0", CODEX_THREAD_ID: "thread-a" },
    { ...env, CODEX_THREAD_ID: " " },
    { ...env, CLAUDECODE: "1" },
  ])("does not invent a binding from insufficient or conflicting evidence: %j", (input) => {
    expect(activeBinding({ ...context, env: input })).toBeNull();
  });
});
