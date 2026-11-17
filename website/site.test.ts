import { describe, expect, it } from "vite-plus/test";
import { renderSite } from "./site.js";

describe("public website presentation boundary", () => {
  it("renders four linked routes with visible empty capture state and progressive controls", () => {
    const site = renderSite({ examples: [] });
    expect([...site.keys()]).toEqual([
      "index.html",
      "how-it-works/index.html",
      "getting-started/index.html",
      "use-cases/index.html",
    ]);
    for (const [path, html] of site) {
      const root = path === "index.html" ? "./" : "../";
      expect(html).toContain('href="#main">Skip to content');
      expect(html).toContain("NO RELEASE CAPTURE LOADED");
      expect(html).toContain("Local preview · no documented release");
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(`href="${root}how-it-works/"`);
      expect(html).toContain(`href="${root}assets/site.css"`);
      expect(html).toContain(`src="${root}assets/copy.js"`);
      expect(html).not.toContain("<iframe");
    }
    expect(site.get("index.html")).toContain('data-copy="install" hidden');
    expect(site.get("index.html")).toContain("Syntax preview only");
  });

  it("escapes hostile capture/provenance text without turning it into executable markup", () => {
    const attack = '<img src=x onerror="alert(1)">&\'"';
    const site = renderSite({
      release: { version: attack, gitHead: attack, capturedAt: attack },
      examples: [
        {
          id: attack,
          title: attack,
          command: attack,
          output: attack,
          provenance: attack,
          notices: [attack],
        },
      ],
    });
    for (const html of site.values()) {
      expect(html).not.toContain(attack);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;&quot;");
      expect(html).toContain('data-copy="example-0"');
      expect(html).toContain("Examples are dated observations, not a live view.");
    }
  });

  it("refuses captured examples without a release identity", () => {
    expect(() =>
      renderSite({
        examples: [
          {
            id: "one",
            title: "one",
            command: "pdb",
            output: "not a live example",
            provenance: "unknown",
            notices: [],
          },
        ],
      }),
    ).toThrow("release provenance");
  });
});
