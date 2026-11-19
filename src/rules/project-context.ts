/**
 * The project half of the effective rules document (#516), shared by `pdb rules` and the serve
 * rules page so both name the same revision the briefing applies: the same enablement setting,
 * read from the same verified checkout, through the same loader.
 */
import { resolveProjectRulesSetting } from "../config/project-rules-setting.js";
import type { GuideRuntime } from "../briefing/process.js";
import { projectLimits, projectRulesView } from "./datalog/project/effective.js";
import type { ProjectLimits, ProjectRulesView } from "./datalog/rules-command.js";

export async function projectRulesContext(
  /** The repository and its verified checkout, or why none was selected. */
  target: { repository: string; runtime: GuideRuntime } | { unknown: string },
): Promise<{ project: ProjectRulesView; limits: ProjectLimits }> {
  const limits = await projectLimits();
  if ("unknown" in target) return { project: { state: "unknown", reason: target.unknown }, limits };
  const { rulesHash, policyVersion } = await import("./datalog/datalog.js");
  const setting = await resolveProjectRulesSetting(target.repository, target.runtime);
  // #1050: the native policy always applies project preferences; there is no engine selector.
  return { project: await projectRulesView(setting, { policyVersion, rulesHash }), limits };
}
