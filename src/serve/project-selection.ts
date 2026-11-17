/** Shared browser navigation state; domain facts come from the existing status API. */
export async function restoreProjectSelection(): Promise<void> {
  const key = "pdb.selected-project";
  try {
    const response = await fetch("/api/v1/status");
    if (!response.ok) return;
    const status = (await response.json()) as { repositories: { repository: string }[] };
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
