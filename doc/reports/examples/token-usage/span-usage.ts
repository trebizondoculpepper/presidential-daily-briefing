/**
 * Manual, local-only measurement for doc/reports/ticket-token-usage.md (#802): the token usage a
 * Claude Code session recorded between two instants (for example a ticket's claim and submit),
 * read from the session's own local transcript. Prints counts and provenance only, never message
 * content. Not part of the test suite and not a PDB feature.
 *
 * Run: npx tsx doc/reports/examples/token-usage/span-usage.ts TRANSCRIPT.jsonl START END
 */
import { readFileSync } from "node:fs";

type Usage = Record<string, unknown>;
const [path, startArg, endArg] = process.argv.slice(2);
if (!path || !startArg || !endArg) throw new Error("usage: span-usage.ts TRANSCRIPT START END");
const start = Date.parse(startArg);
const end = Date.parse(endArg);

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** One response's tokens: per-iteration counters when present, else the top-level ones. */
function tokens(u: Usage) {
  const its = Array.isArray(u.iterations) ? (u.iterations as Usage[]) : [];
  const from = its.length ? its : [u];
  const sum = (k: string) => from.reduce((s, x) => s + n(x[k]), 0);
  return {
    input: sum("input_tokens"),
    cacheRead: sum("cache_read_input_tokens"),
    cacheWrite: sum("cache_creation_input_tokens"),
    output: sum("output_tokens"),
  };
}

// A response is written as several records sharing message.id; the last record is final.
const responses = new Map<
  string,
  { at: number; sidechain: boolean; model: string; usage: Usage }
>();
let records = 0;
for (const line of readFileSync(path, "utf8").split("\n")) {
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
    sidechain: o.isSidechain === true,
    model: String(m.model ?? "unknown"),
    usage: m.usage as Usage,
  });
}

const totals = (main: boolean) => {
  const t = { responses: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const models = new Set<string>();
  for (const r of responses.values()) {
    if (r.sidechain === main) continue;
    const k = tokens(r.usage);
    t.responses++;
    t.input += k.input;
    t.cacheRead += k.cacheRead;
    t.cacheWrite += k.cacheWrite;
    t.output += k.output;
    models.add(r.model);
  }
  return { ...t, models: [...models] };
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
      complete: false,
      note: "Usage written after END, compaction summaries and other sessions are not included.",
    },
    null,
    2,
  ),
);
