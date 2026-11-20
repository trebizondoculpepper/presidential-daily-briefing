<script lang="ts">
  import { formatDuration, ticketLink } from "./client.js";
  import type { TimingState } from "./client.js";

  /** Creation to first pickup by current impact (#821). */
  let { state, pageLoading }: { state: TimingState; pageLoading: boolean } = $props();
</script>

{#if state.status === "ready"}
  {@const r = state.response}
  <section aria-labelledby="pickup-delay">
    <h2 id="pickup-delay">Creation to first pickup</h2>
    <p class="explain">
      From the issue's creation to its earliest proven pickup (a trusted PDB claim record or agent
      label), for tickets created in the window. Grouped by the ticket's <strong>current</strong>
      valid impact, not its impact at pickup. Median first, with the mean and the number picked up;
      p75 and p90 only with at least 20. Tickets never picked up are shown with the time waited so
      far as a lower bound while open, and counted separately once closed. A ticket whose creation
      or pickup history was not read counts as unknown, never as zero.
    </p>
    <p class="section-status">
      {r.status === "incomplete" ? "Partial figures. " : ""}{r.freshness ? `Observed ${r.freshness.observedAt}${r.freshness.stale ? " (stale)" : ""}.` : "Observation time not supplied."}
    </p>
    <p class="explain">Cohort: <code>{r.cohort}</code></p>
    {#if r.coverageNote}<p class="warn">{r.coverageNote}</p>{/if}
    {#each r.warnings as w}<p class="warn">{w}</p>{/each}
    {#if r.groups.length === 0}
      <p>{r.status === "incomplete" ? "No tickets were found, but the read was partial." : "No tickets were created in this window."}</p>
    {:else}
      <table class="timing-table">
        <caption>Creation to first pickup by current impact</caption>
        <thead>
          <tr>
            <th scope="col">Current impact</th>
            <th scope="col">Median</th>
            <th scope="col">Mean</th>
            <th scope="col">Picked up</th>
            <th scope="col">p75</th>
            <th scope="col">p90</th>
            <th scope="col">Not yet picked up (lower bound)</th>
            <th scope="col">Unknown</th>
            <th scope="col">Closed without pickup</th>
          </tr>
        </thead>
        <tbody>
          {#each r.groups as g (g.name)}
            <tr>
              <th scope="row">{g.name}</th>
              <td>{formatDuration(g.stats.median)}</td>
              <td>{formatDuration(g.stats.mean)}</td>
              <td>{g.stats.completed}</td>
              <td>{g.stats.p75 === null ? "n<20" : formatDuration(g.stats.p75)}</td>
              <td>{g.stats.p90 === null ? "n<20" : formatDuration(g.stats.p90)}</td>
              <td>{g.stats.open.count}{g.stats.open.longestElapsedMs !== null ? ` (≥ ${formatDuration(g.stats.open.longestElapsedMs)})` : ""}</td>
              <td>{g.stats.unknown}</td>
              <td>{g.stats.closedUndelivered}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#each r.groups as g (g.name)}
        <details class="drill">
          <summary>{g.name}: the tickets behind these figures</summary>
          {#each [["Picked up", g.stats.members.completed], ["Not yet picked up", g.stats.members.open], ["Unknown", g.stats.members.unknown], ["Closed without pickup", g.stats.members.closedUndelivered]] as [label, members]}
            {#if (members as string[]).length}
              <p>{label}:
                {#each members as string[] as m, i}{i ? ", " : ""}{#if ticketLink(m, window.location.search)}<a href={ticketLink(m, window.location.search)}>{m}</a>{:else}{m}{/if}{/each}
              </p>
            {/if}
          {/each}
        </details>
      {/each}
    {/if}
  </section>
{:else if state.status === "error"}
  <p class="error" role="alert">Creation-to-pickup figures could not be loaded: {state.message}</p>
{:else if state.status === "loading" && !pageLoading}
  <p role="status">Loading creation-to-pickup figures…</p>
{/if}
