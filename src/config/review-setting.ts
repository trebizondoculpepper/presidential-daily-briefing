/**
 * Repository-scoped `review.policy` (#301, doc/design/declared-review-policy.md). Absent setting
 * is reported as undeclared legacy; unreadable configuration is unknown, never a guess.
 */
import {
  ConfigError,
  loadConfig,
  settingFor,
  resolveRepositoryTarget,
  nodeFileSystem,
} from "./config.js";
import type { GuideRuntime } from "../briefing/process.js";
import { reviewPolicyIds } from "../workflow/reviewpolicy.js";
import type { DeclaredReviewPolicy, ReviewPolicyId } from "../workflow/reviewpolicy.js";

/**
 * Read the declared policy for `repository`. A remote read with no matching local checkout is
 * undeclared with scope `no-matching-project`: no other project's settings are consulted.
 */
export async function resolveReviewPolicy(
  repository: string,
  runtime?: GuideRuntime,
): Promise<DeclaredReviewPolicy> {
  if (!runtime) return { state: "undeclared", scope: "not-read" };
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
      return { state: "undeclared", scope: "no-matching-project" };
    return { state: "unknown", reason: "the repository configuration could not be resolved" };
  }
  try {
    const setting = settingFor(
      await loadConfig(target.root, runtime.fs ?? nodeFileSystem),
      "review.policy",
    );
    if (setting.value === null) return { state: "undeclared", scope: "repository-config" };
    if ((reviewPolicyIds as readonly unknown[]).includes(setting.value))
      return { state: "declared", policy: setting.value as ReviewPolicyId };
    return { state: "unknown", reason: `unregistered review.policy ${String(setting.value)}` };
  } catch (error) {
    return {
      state: "unknown",
      reason: `repository configuration cannot be read or validated${error instanceof ConfigError ? ` (${error.code})` : ""}`,
    };
  }
}
