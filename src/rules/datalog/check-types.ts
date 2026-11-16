/** Factual input to the native required-check query. No GitHub objects or policy verdicts. */
export interface CheckEvidence {
  complete: boolean;
  gaps: readonly string[];
  checks: readonly {
    name: string;
    databaseId?: number | null;
    appId?: number | null;
    outcome: string;
    required: "required" | "advisory" | "unknown";
  }[];
  missing: readonly string[];
}
