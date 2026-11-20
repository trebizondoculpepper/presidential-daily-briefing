<script lang="ts">
  import { formatAge, shownStages, ticketLink } from "./client.js";
  import type { InventoryResponse } from "./client.js";

  let { response }: { response: InventoryResponse } = $props();
  /** Members listed per drill-down; the rest are counted, never silently dropped. */
  const shown = 25;
  const labels = { ready: "Ready", blocked: "Blocked", claimed: "Agent-claimed" } as const;
  const result = $derived(response.result);
  const notShown = $derived(
    result.totalOpen - shownStages.reduce((n, s) => n + result.stages[s].count, 0),
  );
</script>

<section class="pipeline-inventory" aria-labelledby="inventory-heading">
  <h2 id="inventory-heading">Current stage inventory</h2>
  <p class="pipeline-note">
    Open tickets now, by the native workflow stage. Stages are exclusive: each ticket is counted in
    one row. This is a current snapshot, not a flow over time. Typical age is the median.
  </p>
  {#if response.status !== "complete"}
    <p class="warn" role="status">Incomplete read: some figures may be missing.</p>
  {/if}
  {#each response.warnings as warning, i (i)}
    <p class="warn" role="status">{warning}</p>
  {/each}
  {#if result.coverage.note}
    <p class="warn" role="status">{result.coverage.note}</p>
  {/if}

  <div class="pipeline-table-scroll">
    <table class="pipeline-table">
      <caption>Ready, blocked and agent-claimed open tickets</caption>
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">Count</th>
          <th scope="col">Typical age</th>
          <th scope="col">Oldest</th>
          <th scope="col">Unknown age</th>
        </tr>
      </thead>
      <tbody>
        {#each shownStages as stage (stage)}
          {@const s = result.stages[stage]}
          <tr>
            <th scope="row">{labels[stage]}</th>
            <td>{s.count}</td>
            <td>{formatAge(s.age.medianMs)}</td>
            <td>{formatAge(s.age.oldestMs)}</td>
            <td>{s.age.unknownCount}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#each shownStages as stage (stage)}
    {@const s = result.stages[stage]}
    {#if s.count}
      <details class="pipeline-members">
        <summary>{labels[stage]}: {s.count} ticket{s.count === 1 ? "" : "s"}</summary>
        <ul>
          {#each s.members.slice(0, shown) as member (member)}
            {@const href = ticketLink(member)}
            <li>
              {#if href}<a {href}>{member}</a>{:else}{member}{/if}
              {#if s.age.unknownMembers.includes(member)}<span class="warn"> (age unknown)</span>{/if}
            </li>
          {/each}
        </ul>
        {#if s.members.length > shown}
          <p>{s.members.length - shown} more not listed.</p>
        {/if}
      </details>
    {/if}
  {/each}

  <p class="pipeline-note">
    {result.totalOpen} open ticket{result.totalOpen === 1 ? "" : "s"} in total;
    {notShown} in other stages (unassessed, in review or unknown) are not in this table.
    {#if result.stateUnknown.count}
      <span class="warn">The stage of {result.stateUnknown.count} could not be established.</span>
    {/if}
  </p>
  <p class="pipeline-note">Observed at <time datetime={result.observedAt}>{result.observedAt}</time>.</p>
</section>
