import { CaptureFailure } from "./failure.js";
import type { PublicationManifest } from "./manifest.js";
import { publicRepository } from "./provenance.js";

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CaptureFailure("Invalid publication API evidence.");
  return value as Record<string, unknown>;
};
export type PublicationRead = (path: string) => Promise<unknown>;

/** Manifest fields are claims until independently matched to the exact official run/release/tag. */
export async function verifyPublication(
  manifest: PublicationManifest,
  read: PublicationRead,
): Promise<void> {
  const run = object(
    await read(
      `repos/${publicRepository}/actions/runs/${manifest.publisher.runId}/attempts/${manifest.publisher.attempt}`,
    ),
  );
  if (
    run.id !== manifest.publisher.runId ||
    run.run_attempt !== manifest.publisher.attempt ||
    run.workflow_id !== manifest.publisher.workflowId ||
    run.path !== manifest.publisher.workflowPath ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "release" ||
    run.head_sha !== manifest.release.gitHead ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    object(run.repository).id !== manifest.repository.id ||
    object(run.repository).full_name !== publicRepository ||
    object(run.head_repository).id !== manifest.repository.id
  )
    throw new CaptureFailure("Publisher run evidence mismatch.");
  const jobs = object(
    await read(
      `repos/${publicRepository}/actions/runs/${manifest.publisher.runId}/attempts/${manifest.publisher.attempt}/jobs?per_page=100`,
    ),
  );
  if (
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.jobs.length > 100
  ) {
    throw new CaptureFailure("Publisher job coverage incomplete.");
  }
  const publishers = jobs.jobs.map(object).filter((job) => job.name === "publish");
  if (
    publishers.length !== 1 ||
    publishers[0]!.status !== "completed" ||
    publishers[0]!.conclusion !== "success"
  ) {
    throw new CaptureFailure("Publisher job did not complete successfully.");
  }
  const steps = publishers[0]!.steps;
  if (
    !Array.isArray(steps) ||
    !["Validate the request", "Tag and GitHub release"].every((name) =>
      steps
        .map(object)
        .some(
          (step) =>
            step.name === name && step.status === "completed" && step.conclusion === "success",
        ),
    )
  ) {
    throw new CaptureFailure("Publisher release completion steps are missing or skipped.");
  }
  const release = object(
    await read(`repos/${publicRepository}/releases/${manifest.officialRelease.id}`),
  );
  if (
    release.id !== manifest.officialRelease.id ||
    release.tag_name !== manifest.officialRelease.tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.published_at !== manifest.officialRelease.publishedAt
  ) {
    throw new CaptureFailure("Official release evidence mismatch.");
  }
  const ref = object(
    await read(`repos/${publicRepository}/git/ref/tags/${manifest.officialRelease.tag}`),
  );
  let target = object(ref.object);
  if (target.type === "tag") {
    if (typeof target.sha !== "string" || !/^[a-f0-9]{40}$/.test(target.sha))
      throw new CaptureFailure("Invalid annotated release tag.");
    target = object(object(await read(`repos/${publicRepository}/git/tags/${target.sha}`)).object);
  }
  if (target.type !== "commit" || target.sha !== manifest.release.gitHead)
    throw new CaptureFailure("Official release source mismatch.");
}
