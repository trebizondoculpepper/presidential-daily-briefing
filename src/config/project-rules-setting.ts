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
  nodeGit,
} from "./config.js";
import type { GuideRuntime } from "../briefing/process.js";

export type ProjectRulesSetting =
  /** Disabled by configuration (`config`/`default`), or no local checkout matched (`no-matching-project`). */
  | { enabled: false; source: "config" | "default" | "no-matching-project" | "not-read" }
  | { enabled: true; source: "config"; root: string }
  /** The configuration could not be read: whether project rules apply is unknown. */
  | { enabled: "unknown"; reason: string };

export async function resolveProjectRulesSetting(
  repository: string,
  runtime?: GuideRuntime,
): Promise<ProjectRulesSetting> {
  if (!runtime) return { enabled: false, source: "not-read" };
  let target;
  try {
    target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
  } catch (error) {
    if (
      error instanceof ConfigError &&
      ["not-a-repository", "repository-mismatch"].includes(error.code)
    )
      return { enabled: false, source: "no-matching-project" };
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
