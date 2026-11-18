import { describe, expect, it } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { projectSelectionScript } from "./project-selection.js";

async function navigate(
  href: string,
  projects: string[],
  saved: string | null,
  broken = false,
  normalized?: string,
) {
  const redirects: string[] = [];
  const writes: string[] = [];
  const sandbox = {
    URL,
    window: {
      location: { href, replace: (value: string) => redirects.push(value) },
      localStorage: {
        getItem: () => {
          if (broken) throw new Error("Disabled");
          return saved;
        },
        setItem: (_key: string, value: string) => {
          if (broken) throw new Error("Disabled");
          writes.push(value);
        },
      },
    },
    fetch: async () => {
      // Work startup uses history.replaceState while the status request is pending.
      if (normalized) sandbox.window.location.href = normalized;
      return {
        ok: true,
        json: async () => ({ repositories: projects.map((repository) => ({ repository })) }),
      };
    },
  };
  await runInNewContext(projectSelectionScript(), sandbox);
  return { redirects, writes };
}
describe("shared project selection", () => {
  it("defaults to the sole registered project while preserving view parameters", async () => {
    const result = await navigate("http://localhost/?role=designer", ["a/b"], null);
    expect(result.redirects).toEqual(["http://localhost/?role=designer&repo=a%2Fb"]);
  });
  it("restores a valid saved project on returning, including Quotas", async () => {
    for (const page of ["/", "/rules", "/quotas"]) {
      expect((await navigate(`http://localhost${page}`, ["a/b", "C/D"], "c/d")).redirects).toEqual([
        `http://localhost${page}?repo=C%2FD`,
      ]);
    }
  });
  it("remembers explicit valid selection instead of an older saved project", async () => {
    expect(await navigate("http://localhost/?repo=c/d", ["a/b", "C/D"], "a/b")).toEqual({
      redirects: [],
      writes: ["C/D"],
    });
  });
  it("remembers a selection after Work normalizes role during the status request", async () => {
    expect(
      await navigate(
        "http://localhost/?repo=c/d",
        ["a/b", "C/D"],
        "a/b",
        false,
        "http://localhost/?repo=c/d&role=implementer",
      ),
    ).toEqual({ redirects: [], writes: ["C/D"] });
  });
  it("does not replace invalid or repeated explicit selections", async () => {
    for (const query of ["repo=gone/repo", "repo=", "repo=a/b&repo=c/d"]) {
      expect(await navigate(`http://localhost/?${query}`, ["a/b"], "a/b")).toEqual({
        redirects: [],
        writes: [],
      });
    }
  });
  it("does not guess among several projects or restore removed projects", async () => {
    for (const projects of [[], ["a/b", "c/d"]]) {
      expect((await navigate("http://localhost/", projects, "removed/repo")).redirects).toEqual([]);
    }
  });
  it("still selects a sole project when browser storage is unavailable", async () => {
    expect((await navigate("http://localhost/", ["a/b"], null, true)).redirects).toEqual([
      "http://localhost/?repo=a%2Fb",
    ]);
  });
});

describe("Working for header (#669)", () => {
  async function header(human: unknown, ok = true) {
    const slot = { textContent: "", attrs: {} as Record<string, string> };
    const sandbox = {
      URL,
      window: {
        location: { href: "http://localhost/?repo=a%2Fb", replace: () => undefined },
        localStorage: { getItem: () => null, setItem: () => undefined },
      },
      document: {
        querySelector: (selector: string) =>
          selector === "[data-working-for]"
            ? {
                set textContent(v: string) {
                  slot.textContent = v;
                },
                setAttribute: (k: string, v: string) => (slot.attrs[k] = v),
              }
            : null,
      },
      fetch: async () => ({
        ok,
        json: async () => ({ repositories: [{ repository: "a/b" }], human }),
      }),
    };
    await runInNewContext(projectSelectionScript(), sandbox);
    return slot;
  }

  it("states whose work this is, with its source and freshness", async () => {
    expect(
      (await header({ state: "current", login: "octo", host: "github.com", source: "gh-login" }))
        .textContent,
    ).toBe("Working for GitHub user octo (github.com, the signed-in gh account)");
    const last = await header({
      state: "last-known",
      login: "octo",
      host: "github.com",
      observedAt: "2026-11-18T00:00:00Z",
      reason: "gh is offline",
    });
    expect(last.textContent).toContain("last known at 2026-11-18T00:00:00Z; gh is offline");
    expect(last.attrs["data-state"]).toBe("last-known");
  });

  it("shows unknown and unavailable honestly, and never renders markup", async () => {
    expect(
      (await header({ state: "unresolved", login: null, reason: "not signed in" })).textContent,
    ).toBe("Working for: unknown (not signed in)");
    expect((await header(undefined)).textContent).toBe("Working for: unavailable");
    expect((await header(undefined, false)).attrs["data-state"]).toBe("unavailable");
    expect(
      (await header({ state: "current", login: "<b>x</b>", host: "github.com" })).textContent,
    ).toContain("<b>x</b>");
  });
});
