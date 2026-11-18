/**
 * Typed issue write operations for the GH service (#942 part 2, #886): the workflow planners
 * describe each write as validated structured data; this module owns both its executable form
 * (run through the shared gh write boundary with comment recovery, #345) and the display command
 * shown in plans and recovery output. Application code never composes write argv itself.
 */

import type { CommentCallOptions } from "../commentwrite.js";

/** One planned issue write. */
export type IssueWrite =
  | {
      kind: "label-create";
      repository: string;
      name: string;
      color: string;
      description?: string;
    }
  | { kind: "labels-edit"; repository: string; number: number; add: string[]; remove: string[] }
  | { kind: "comment"; repository: string; number: number; body: string };

/** The step key holding a planned write: invisible to JSON, kept by object spread. */
export const WRITE: unique symbol = Symbol("pdb.issue-write");

/** The display (and dispatch) command of a write: `gh` arguments, never joined into a shell. */
export function writeCommand(op: IssueWrite): string[] {
  switch (op.kind) {
    case "label-create":
      return [
        "label",
        "create",
        op.name,
        "--repo",
        op.repository,
        "--color",
        op.color,
        ...(op.description !== undefined ? ["--description", op.description] : []),
      ];
    case "labels-edit":
      return [
        "issue",
        "edit",
        String(op.number),
        "--repo",
        op.repository,
        ...op.add.flatMap((l) => ["--add-label", l]),
        ...op.remove.flatMap((l) => ["--remove-label", l]),
      ];
    case "comment":
      return ["issue", "comment", String(op.number), "--repo", op.repository, "--body", op.body];
  }
}

/** The shared gh write boundary: production `ghRun` (bounded comment recovery); tests fake it. */
export type WriteRun = (args: string[], call?: CommentCallOptions) => Promise<unknown>;

/** Applies typed issue writes. */
export interface IssueWrites {
  /** Apply one write; comments get the call's guard for a throttled retry (#345). */
  apply(op: IssueWrite, call?: CommentCallOptions): Promise<void>;
}

/** Issue writes over one gh write boundary. Nothing is retried blindly here. */
export function issueWrites(run: WriteRun): IssueWrites {
  return {
    async apply(op, call) {
      await run(writeCommand(op), call);
    },
  };
}
