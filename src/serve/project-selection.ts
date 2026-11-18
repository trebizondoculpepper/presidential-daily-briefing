/** Shared browser navigation state; domain facts come from the existing status API. */
export async function restoreProjectSelection(): Promise<void> {
  const key = "pdb.selected-project";
  try {
    const response = await fetch("/api/v1/status");
    if (!response.ok) {
      const slot =
        typeof document === "undefined" ? null : document.querySelector("[data-working-for]");
      if (slot) {
        slot.textContent = "Working for: unavailable";
        slot.setAttribute("data-state", "unavailable");
      }
      return;
    }
    const status = (await response.json()) as {
      repositories: { repository: string }[];
      human?: {
        state?: string;
        login?: string | null;
        host?: string;
        observedAt?: string;
        reason?: string;
      };
    };
    // The shared "Working for" header (#669): text only, never markup from the API.
    const slot =
      typeof document === "undefined" ? null : document.querySelector("[data-working-for]");
    if (slot) {
      const h = status.human;
      const text =
        h?.state === "current" && h.login
          ? `Working for GitHub user ${h.login} (${h.host ?? "github.com"}, the signed-in gh account)`
          : h?.state === "last-known" && h.login
            ? `Working for GitHub user ${h.login} (last known at ${h.observedAt ?? "an earlier time"}; ${h.reason ?? "the current login could not be read"})`
            : h?.state === "unresolved"
              ? `Working for: unknown (${h.reason ?? "no GitHub login could be resolved"})`
              : h?.state === "disabled"
                ? "Working for: not shown (human context is disabled)"
                : "Working for: unavailable";
      slot.textContent = text;
      slot.setAttribute("data-state", h?.state ?? "unavailable");
    }
    // Read current navigation after awaiting status: Work may normalize role/agent meanwhile.
    const url = new URL(window.location.href);
    const projects = status.repositories.map((entry) => entry.repository);
    const canonical = (value: string | null) =>
      projects.find((project) => project.toLowerCase() === value?.toLowerCase());
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(key);
    } catch {
      // Browser privacy settings may disable persistence; ordinary navigation still works.
    }
    if (url.searchParams.has("repo")) {
      if (url.searchParams.getAll("repo").length !== 1) return;
      const selected = canonical(url.searchParams.get("repo"));
      if (selected) {
        try {
          window.localStorage.setItem(key, selected);
        } catch {
          // Persistence is optional.
        }
      }
      return;
    }
    const selected = canonical(remembered) ?? (projects.length === 1 ? projects[0] : undefined);
    if (!selected) return;
    url.searchParams.set("repo", selected);
    window.location.replace(url.href);
  } catch {
    // Status unavailable: keep the existing page and its explicit selection controls.
  }
}
export const projectSelectionScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(${restoreProjectSelection.toString()})();\n`;
