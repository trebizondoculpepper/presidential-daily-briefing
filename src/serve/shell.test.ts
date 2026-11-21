import { describe, expect, it } from "vite-plus/test";
import {
  pageById,
  pageHref,
  renderToolbar,
  resolvePageSelection,
  shellContext,
  shellPage,
  servedPages,
} from "./shell.js";
const served = [{ repository: "Owner/Project" }, { repository: "other/repo" }];
const context = (page: string, query = "") =>
  shellContext(page, served, new URLSearchParams(query));
describe("shared served-page shell (#605)", () => {
  it("never guesses a project, even with one served, and distinguishes account/global scope", () => {
    expect(shellContext("work", served.slice(0, 1)).selection).toMatchObject({
      state: "none",
      repository: null,
    });
    expect(context("quotas").selection.state).toBe("account");
    expect(
      resolvePageSelection(new URLSearchParams(), served, {
        ...pageById("setup"),
        scope: "global-or-project",
      }).state,
    ).toBe("global");
  });
  it("binds canonical served spelling and refuses malformed, unserved and repeated inputs", () => {
    expect(context("work", "repo=owner/project").selection.repository).toBe("Owner/Project");
    for (const query of [
      "repo=",
      "repo=../x",
      "repo=a/b&repo=c/d",
      "extra=x",
      "role=admin",
      "agent=bad%20name",
    ])
      expect(context("work", query).selection).toMatchObject({
        state: "malformed",
        status: 400,
        repository: null,
      });
    expect(context("work", "repo=unserved/repo").selection).toMatchObject({
      state: "unserved",
      status: 403,
    });
    expect(context("quotas", "repo=owner/project&role=designer&agent=a.b").selection).toMatchObject(
      {
        status: 200,
        state: "account",
        repository: "Owner/Project",
      },
    );
    expect(context("quotas", "extra=x").selection.status).toBe(400);
    expect(context("quotas", "repo=unserved/repo").selection.status).toBe(403);
  });
  it("carries only equivalent view keys, encoding values and dropping page-specific filters", () => {
    const from = context("ticket", "repo=owner/project&n=2&role=designer&agent=a.b");
    expect(pageHref(pageById("work"), from.selection, pageById("ticket"))).toBe(
      "/?repo=Owner%2FProject&role=designer&agent=a.b",
    );
    expect(pageHref(pageById("setup"), from.selection, pageById("ticket"))).toBe(
      "/setup?repo=Owner%2FProject",
    );
    expect(pageHref(pageById("quotas"), from.selection, pageById("ticket"))).toBe(
      "/quotas?repo=Owner%2FProject&role=designer&agent=a.b",
    );
    const onQuotas = context("quotas", "repo=owner/project&role=designer&agent=a.b");
    expect(pageHref(pageById("work"), onQuotas.selection, pageById("quotas"))).toBe(
      "/?repo=Owner%2FProject&role=designer&agent=a.b",
    );
    expect(pageHref(pageById("rules"), onQuotas.selection, pageById("quotas"))).toBe(
      "/rules?repo=Owner%2FProject",
    );
    const rules = context("rules", "repo=Owner/Project&rule=D-PR-MERGE&role=designer");
    expect(
      pageHref(
        pageById("rules"),
        { ...rules.selection, repository: "other/repo" },
        pageById("rules"),
      ),
    ).toBe("/rules?repo=other%2Frepo");
    const hostile = {
      ...from.selection,
      query: new URLSearchParams({ role: '"<&?#', agent: "a b/é" }),
    };
    expect(pageHref(pageById("work"), hostile, pageById("ticket"))).toContain(
      "role=%22%3C%26%3F%23&agent=a+b%2F%C3%A9",
    );
  });
  it("renders one escaped toolbar, active section, skip target and shipped links without I/O", () => {
    const c = context("ticket", "repo=Owner/Project&n=1&role=designer&agent=me");
    const html = shellPage(c, "Ticket <&", "<p>Contents</p>");
    expect(html).toContain('href="#content">Skip to content');
    expect(html).toContain('id="content" tabindex="-1"');
    expect(html).toContain('aria-current="page">Work</a>');
    expect(html).toContain('aria-current="true">Owner/Project</a>');
    expect(html).toContain('href="/?repo=other%2Frepo&amp;role=designer&amp;agent=me"');
    expect(html).toContain("Ticket &lt;&amp;");
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script(?! src=)|<style|\sstyle=|https?:\/\//);
    expect(html).not.toContain("Project: Owner/Project");
    expect(html).toContain('<script src="/project-selection.js" defer></script>');
    // #733: the project selector is always visible, including account-wide Quotas, which keeps
    // its account-wide labelling.
    expect(renderToolbar(context("quotas"))).toContain("Change project");
    expect(renderToolbar(context("quotas"))).toContain("Account-wide");
    // #818: a global-or-project page's project menu offers Global, clearing a selected repository,
    // so the Global settings stay reachable through the UI from any project-scoped page.
    expect(renderToolbar(context("configuration", "repo=owner/project"))).toContain(
      'href="/configuration">Global</a>',
    );
    // While a project is selected, the project entry is current; Global becomes current only when
    // no repository is selected.
    expect(renderToolbar(context("configuration", "repo=owner/project"))).not.toContain(
      'href="/configuration" aria-current="true"',
    );
    expect(renderToolbar(context("configuration"))).toContain(
      'href="/configuration" aria-current="true">Global</a>',
    );
    // Pages that cannot show Global (project-only scope) do not offer it.
    expect(renderToolbar(context("work", "repo=owner/project"))).not.toContain(">Global</a>");
    // #669: every page's toolbar carries the accessible, text-only "Working for" slot.
    for (const page of ["work", "quotas", "rules"])
      expect(renderToolbar(context(page))).toContain(
        '<p class="working-for" data-working-for role="status" aria-live="polite">Working for: loading…</p>',
      );
    for (const page of servedPages.filter((p) => p.shipped && !p.section && !p.preview))
      expect(html).toContain(page.label);
    // #753: an opt-in preview is served but never listed.
    for (const page of servedPages.filter((p) => p.preview))
      expect(html).not.toContain(`href="${page.path}`);
    expect(html).not.toContain('href="/settings');
  });
});
