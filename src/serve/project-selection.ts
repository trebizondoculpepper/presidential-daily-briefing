/** Shared browser navigation state; domain facts come from the existing status API. */
export async function restoreProjectSelection(): Promise<void> {
  const key = "pdb.selected-project";
  type Human = {
    state?: string;
    login?: string | null;
    host?: string;
    observedAt?: string;
    reason?: string;
  };
  // The shared "Working for" header (#669): text only, never markup from the API. Every outcome
  // of a status read (answered, refused, rejected, undecodable) leaves an honest state.
  const fill = (human: Human | undefined | null): void => {
    const slot =
      typeof document === "undefined" ? null : document.querySelector("[data-working-for]");
    if (!slot) return;
    const h = human ?? undefined;
    slot.textContent =
      h?.state === "current" && h.login
        ? `Working for GitHub user ${h.login} (${h.host ?? "github.com"}, the signed-in gh account${h.observedAt ? `, verified ${h.observedAt}` : ""})`
        : h?.state === "last-known" && h.login
          ? `Working for GitHub user ${h.login} (last known at ${h.observedAt ?? "an earlier time"}; ${h.reason ?? "the current login could not be read"})`
          : h?.state === "unresolved"
            ? `Working for: unknown (${h.reason ?? "no GitHub login could be resolved"})`
            : h?.state === "disabled"
              ? "Working for: not shown (human context is disabled)"
              : "Working for: unavailable";
    slot.setAttribute("data-state", h?.state ?? "unavailable");
  };
  // Only the latest read may change the header: a slower, older read never replaces a newer one.
  let generation = 0;
  const readStatus = async (): Promise<{
    repositories: { repository: string }[];
    human?: Human;
  } | null> => {
    const mine = ++generation;
    const latest = (human: Human | undefined | null) => {
      if (mine === generation) fill(human);
    };
    try {
      const response = await fetch("/api/v1/status");
      if (!response.ok) {
        latest(null);
        return null;
      }
      const status = (await response.json()) as {
        repositories: { repository: string }[];
        human?: Human;
      };
      latest(status.human);
      return status;
    } catch {
      latest(null);
      return null;
    }
  };
  // A live read may revalidate or change the server's human (gh auth switch, refused auth):
  // pages announce a completed refresh and the header re-reads status. No polling.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function")
    document.addEventListener("pdb:refreshed", () => void readStatus());
  try {
    const status = await readStatus();
    if (!status) return;
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
    // A page can declare it does not auto-select a project (#818): it keeps its own default
    // scope (for example the Configuration page shows Global), and automatic restoration is
    // skipped here. Explicit selections above are still remembered, and the shared header is
    // already filled.
    if (
      typeof document !== "undefined" &&
      document.querySelector("[data-project-selection='none']")
    )
      return;
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
