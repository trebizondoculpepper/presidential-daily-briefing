/**
 * Repository-scoped `rules.project.enabled` (#516, doc/design/native-project-rules.md
 * "Configuration, identity, English and packaging"). Enablement is program-mediated
 * configuration; a `pdb.rules.edn` file alone never enables anything. An enabled setting carries
 * the verified checkout root its policy file is read from, never a caller-supplied path.
 */
import {
  ConfigError,
  loadConfig,
  settingFor,
  resolveRepositoryTarget,
  nodeFileSystem,
} from "./config.js";
import type { GuideRuntime } from "../briefing/process.js";

export type ProjectRulesSetting =
  /** Disabled by the repository's own configuration (`config`) or its registry default. */
  | { enabled: false; source: "config" | "default" }
  /**
   * No local checkout of the repository is selected (a remote CLI read, `pdb serve --repo`, MCP
   * without `--project`), so its committed configuration cannot be read at all. Reported as its
   * own explicit state with the remedy, never as "disabled" (#516).
   */
  | { enabled: "unavailable"; reason: string }
  | { enabled: true; source: "config"; root: string }
  /** The configuration could not be read: whether project rules apply is unknown. */
  | { enabled: "unknown"; reason: string };

/** Why a selection without a matching local checkout cannot know its project rules. */
export const noCheckout = (repository: string): string =>
  `no local checkout of ${repository} is selected, so its committed configuration and pdb.rules.edn cannot be read; run pdb inside that checkout, or start pdb serve or pdb-mcp with --project`;

export async function resolveProjectRulesSetting(
  repository: string,
  runtime?: GuideRuntime,
): Promise<ProjectRulesSetting> {
  if (!runtime) return { enabled: "unavailable", reason: noCheckout(repository) };
  let target;
  try {
    target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      // The runtime's runner, or none: the typed Git service's isolated default (#904).
      runtime.git,
    );
  } catch (error) {
    if (
      error instanceof ConfigError &&
      ["not-a-repository", "repository-mismatch"].includes(error.code)
    )
      return { enabled: "unavailable", reason: noCheckout(repository) };
    return { enabled: "unknown", reason: "the repository configuration could not be resolved" };
  }
  try {
    const setting = settingFor(
      await loadConfig(target.root, runtime.fs ?? nodeFileSystem),
      "rules.project.enabled",
    );
    if (setting.value === true) return { enabled: true, source: "config", root: target.root };
    return { enabled: false, source: setting.source === "explicit" ? "config" : "default" };
  } catch (error) {
    return {
      enabled: "unknown",
      reason: `repository configuration cannot be read or validated${error instanceof ConfigError ? ` (${error.code})` : ""}`,
    };
  }
}
