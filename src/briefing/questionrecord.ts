/**
 * One needs-human question record as the human views read it (#457, #414): shared by the
 * open-ticket reader (human.ts) and the closed-source collector (closedquestions.ts).
 */
import type { Comment } from "../github/types.js";
import { parseQuestionMarker, parseQuestionRecordBody } from "../workflow/claims.js";

/** Prefix of the hidden marker `pdb needs-human` writes (src/workflow/claims.ts). */
export const recordMarker = "<!-- github-triage:needs-human:";

/** One parsed needs-human record. */
export interface HumanRecord {
  /** The record comment's URL: the focused source link. */
  url: string;
  createdAt: string;
  marker: string;
  /** `Designer:` routing name, "" when unreadable. */
  to: string;
  raisedBy: string;
  why: string;
  questions: string[];
  /**
   * Marker version (#412): 1 legacy, 2 bound to its repository/issue with explicit-resolution
   * semantics. On open tickets both still resolve by labels here (#413); on a closed source a v2
   * question stays open until an explicit resolve or withdraw (#414, closedquestions.ts).
   */
  version: 1 | 2;
  /** The needs-human operation id that identifies this question. */
  opId: string;
}

/** Parse a needs-human record comment; null when it carries no record marker. */
export function parseQuestionRecord(comment: Comment): HumanRecord | null {
  const body = comment.body ?? "";
  const at = body.indexOf(recordMarker);
  if (at < 0) return null;
  const end = body.indexOf("-->", at);
  const marker = body.slice(at, end < 0 ? undefined : end + 3);
  // The same format `pdb needs-human` writes (workflow/claims.ts), multiline values included.
  const parts = parseQuestionRecordBody(body.slice(0, at));
  const parsed = parseQuestionMarker(body);
  return {
    version: parsed?.version === 2 ? 2 : 1,
    opId: parsed?.opId ?? "",
    url: comment.url,
    createdAt: comment.createdAt ?? "",
    marker,
    to: parts?.designer ?? "",
    raisedBy: parts?.agent ?? "",
    why: parts?.why ?? "",
    questions: parts?.questions ?? [],
  };
}
