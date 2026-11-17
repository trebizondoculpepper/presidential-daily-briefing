import { describe, expect, it } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { projectSelectionScript } from "./project-selection.js";

async function navigate(href: string, projects: string[], saved: string | null, broken = false) {
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
    fetch: async () => ({
      ok: true,
      json: async () => ({ repositories: projects.map((repository) => ({ repository })) }),
    }),
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
