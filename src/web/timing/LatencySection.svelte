<script lang="ts">
  import { formatDuration, ticketLink } from "./client.js";
  import type { LatencyState } from "./client.js";

  /** One creation-to-first-assessment latency section (#822 impact, #823 complexity). */
  let {
    metric,
    state,
    pageLoading,
  }: { metric: "impact" | "complexity"; state: LatencyState; pageLoading: boolean } = $props();
  const id = $derived(`${metric}-latency`);
</script>

{#if state.status === "ready"}
  {@const r = state.response}
  <section aria-labelledby={id}>
    <h2 {id}>Creation to first {metric} assessment</h2>
    <p class="explain">
      From the issue's creation to its earliest trusted {metric} assessment record, for tickets
      first assessed in the window. Median first, with the mean and the number of completed
      tickets; p75 and p90 only with at least 20. Tickets still waiting for their first {metric}
      assessment are shown with the time waited so far as a lower bound; closed tickets that were
      never assessed are counted separately. A ticket whose creation or first assessment is
      missing, unread, invalid or out of order counts as unknown, never as zero; the server does
      not yet say which of those reasons applies. Only {metric} assessments are measured here.
    </p>
    <p class="section-status">
      {r.status === "incomplete" ? "Partial figures. " : ""}{r.freshness ? `Observed ${r.freshness.observedAt}${r.freshness.stale ? " (stale)" : ""}.` : "Observation time not supplied."}
    </p>
    {#if r.coverageNote}<p class="warn">{r.coverageNote}</p>{/if}
    {#each r.warnings as w}<p class="warn">{w}</p>{/each}
    <table class="timing-table">
      <caption>Creation to first {metric} assessment</caption>
      <thead>
        <tr>
          <th scope="col">Median</th>
          <th scope="col">Mean</th>
          <th scope="col">Completed</th>
          <th scope="col">p75</th>
          <th scope="col">p90</th>
          <th scope="col">Not yet assessed (lower bound)</th>
          <th scope="col">Unknown</th>
          <th scope="col">Closed unassessed</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{formatDuration(r.stats.median)}</td>
          <td>{formatDuration(r.stats.mean)}</td>
          <td>{r.stats.completed}</td>
          <td>{r.stats.p75 === null ? "n<20" : formatDuration(r.stats.p75)}</td>
          <td>{r.stats.p90 === null ? "n<20" : formatDuration(r.stats.p90)}</td>
          <td>{r.stats.open.count}{r.stats.open.longestElapsedMs !== null ? ` (≥ ${formatDuration(r.stats.open.longestElapsedMs)})` : ""}</td>
          <td>{r.stats.unknown}</td>
          <td>{r.stats.closedUndelivered}</td>
        </tr>
      </tbody>
    </table>
    <details class="drill">
      <summary>The tickets behind these figures</summary>
      {#each [["Completed", r.stats.members.completed], ["Not yet assessed", r.stats.members.open], ["Unknown", r.stats.members.unknown], ["Closed unassessed", r.stats.members.closedUndelivered]] as [label, members]}
        {#if (members as string[]).length}
          <p>{label}:
            {#each members as string[] as m, i}{i ? ", " : ""}{#if ticketLink(m, window.location.search)}<a href={ticketLink(m, window.location.search)}>{m}</a>{:else}{m}{/if}{/each}
          </p>
        {/if}
      {/each}
    </details>
  </section>
{:else if state.status === "error"}
  <p class="error" role="alert">{metric === "impact" ? "Impact" : "Complexity"} assessment latency could not be loaded: {state.message}</p>
{:else if state.status === "loading" && !pageLoading}
  <p role="status">Loading {metric} assessment latency…</p>
{/if}
