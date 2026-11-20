/**
 * Manual, local-only measurement for doc/reports/ticket-token-usage.md (#802): the token usage a
 * Claude Code session recorded between two instants (for example a ticket's claim and submit),
 * read from the session's own local transcript. Prints counts and provenance only, never message
 * content. Not part of the test suite and not a PDB feature.
 *
 * Run: npx tsx doc/reports/examples/token-usage/span-usage.ts TRANSCRIPT.jsonl START END
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type Usage = Record<string, unknown>;
const [path, startArg, endArg] = process.argv.slice(2);
if (!path || !startArg || !endArg) throw new Error("usage: span-usage.ts TRANSCRIPT START END");
const start = Date.parse(startArg);
const end = Date.parse(endArg);

/** A counter as recorded: a number, or null when the record does not carry it (unknown, not 0). */
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const keys = {
  input: "input_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheWrite: "cache_creation_input_tokens",
  output: "output_tokens",
} as const;
type Key = keyof typeof keys;
/** One response's counters: per-iteration when present, else top-level; null when missing. */
function tokens(u: Usage): Record<Key, number | null> {
  const its = Array.isArray(u.iterations) && u.iterations.length ? (u.iterations as Usage[]) : [u];
  const out = {} as Record<Key, number | null>;
  for (const k of Object.keys(keys) as Key[]) {
    const values = its.map((x) => n(x[keys[k]]));
    out[k] = values.some((v) => v === null) ? null : values.reduce((a, b) => a! + b!, 0);
  }
  return out;
}

// A response is written as several records sharing message.id; the last record is final.
type Response = { at: number; sidechain: boolean; model: string; usage: Usage };
const responses = new Map<string, Response>();
let records = 0;
/** Read one transcript; subagent transcripts count as sidechain whatever their records say. */
function read(file: string, subagent: boolean) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message as Record<string, unknown> | undefined;
    if (o.type !== "assistant" || !m?.usage || typeof m.id !== "string") continue;
    const at = Date.parse(String(o.timestamp));
    if (!(at >= start && at <= end)) continue;
    records++;
    responses.set(m.id, {
      at,
      sidechain: subagent || o.isSidechain === true,
      model: String(m.model ?? "unknown"),
      usage: m.usage as Usage,
    });
  }
}
read(path, false);
// Claude Code writes subagent transcripts beside the session's: <session>/subagents/*.jsonl.
const subagentDir = join(dirname(path), basename(path, ".jsonl"), "subagents");
const subagentFiles = existsSync(subagentDir)
  ? readdirSync(subagentDir).filter((f) => f.endsWith(".jsonl"))
  : [];
for (const f of subagentFiles) read(join(subagentDir, f), true);

const totals = (main: boolean) => {
  const t: Record<Key, number> & { responses: number } = {
    responses: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  /** Responses missing each counter: their totals are then lower bounds, not complete. */
  const missing: Record<Key, number> = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const models = new Set<string>();
  for (const r of responses.values()) {
    if (r.sidechain === main) continue;
    const k = tokens(r.usage);
    t.responses++;
    for (const key of Object.keys(keys) as Key[]) {
      if (k[key] === null) missing[key]++;
      else t[key] += k[key]!;
    }
    models.add(r.model);
  }
  return { ...t, missing, models: [...models] };
};
console.log(
  JSON.stringify(
    {
      source: "claude-code local transcript (assistant message usage)",
      interval: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      assistantRecords: records,
      distinctResponses: responses.size,
      main: totals(true),
      sidechains: totals(false),
      subagentTranscriptsRead: subagentFiles.length,
      complete: false,
      note: "Usage written after END, compaction summaries and other sessions are not included.",
    },
    null,
    2,
  ),
);
