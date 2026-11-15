/**
 * The registered workflow definition: readiness, ownership, attention and check-state labels and
 * values shared by briefings, claims, delivery and diagnostics. Data only; it imports nothing, so
 * any module can depend on it without joining an import cycle (#437).
 */
export const workflow = {
  readiness: [
    "status:ready",
    "status:incomplete",
    "status:needs-design",
    "status:blocked",
    "status:parked",
    // A handed-over contribution with an open PR (#62); a state, but never implementation pickup.
    "status:awaiting-review",
  ],
  ready: "status:ready",
  parked: "status:parked",
  blocked: "status:blocked",
  reasonPrefix: "blocked:",
  retiredReason: "blocked:work",
  attention: [
    "status:needs-design",
    "question",
    "help wanted",
    "blocked:testing",
    "blocked:credential",
  ],
  // Explicit, agent-maintained designer markers (#40); never inferred from chronology.
  designMarkers: {
    "design:decision-needed": "design-decision-needed",
    "design:documentation-needed": "design-documentation-needed",
  },
  // Manual pickup-order overrides (#43). Ordering only: never eligibility, claims or authority.
  urgency: { high: "urgency:high", low: "urgency:low" },
  ownerPrefix: "agent:",
  openStates: ["OPEN"],
  completedReasons: ["COMPLETED", "MERGED"],
  failure: [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ],
  unfinished: ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"],
  pass: ["SUCCESS", "NEUTRAL", "SKIPPED"],
  verify: "verify",
  verifySuccess: ["SUCCESS"],
  changesRequested: ["CHANGES_REQUESTED"],
  conflicts: ["CONFLICTING"],
  mergeable: ["MERGEABLE"],
  currentMergeStates: ["CLEAN", "HAS_HOOKS", "UNSTABLE"],
  /** Merge states of an accepted PR that need a refresh or branch update, not waiting (#182 S9). */
  refreshMergeStates: ["BEHIND", "UNKNOWN"],
  unknownMergeable: ["UNKNOWN"],
};
