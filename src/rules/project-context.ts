/**
 * The project half of the effective rules document (#516), shared by `pdb rules` and the serve
 * rules page so both name the same revision the briefing applies: the same enablement setting,
 * read from the same verified checkout, through the same loader.
 */
import { resolveProjectRulesSetting } from "../config/project-rules-setting.js";
import { BriefingEngineError, resolveEngineSetting } from "../config/engine-setting.js";
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
  // The briefing applies project preferences only with the Datalog engine; the TypeScript
  // rollback reports a policy error there, so the listing must not call them in force either.
  if (setting.enabled === true || setting.enabled === "unknown") {
    let engine: string;
    try {
      engine = (await resolveEngineSetting(target.repository, target.runtime)).requested;
    } catch (error) {
      if (!(error instanceof BriefingEngineError)) throw error;
      engine = "unknown";
    }
    if (engine !== "datalog")
      return {
        project: {
          state: "error",
          reason:
            engine === "typescript"
              ? "project preferences need briefing.engine datalog; the TypeScript rollback engine is in use"
              : "the briefing engine setting cannot be read, so whether project preferences can apply is unknown",
          next: [
            "pdb config set briefing.engine datalog",
            "pdb config set rules.project.enabled false",
          ],
        },
        limits,
      };
  }
  return { project: await projectRulesView(setting, { policyVersion, rulesHash }), limits };
}
