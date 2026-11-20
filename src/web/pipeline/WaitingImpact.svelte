<script lang="ts">
  import { formatAge, ticketLink, waitingGroupOrder } from "./client.js";
  import type { WaitingResponse } from "./client.js";
  import Freshness from "./Freshness.svelte";

  let { response }: { response: WaitingResponse } = $props();
  /** Members listed per drill-down; the rest are counted, never silently dropped. */
  const shown = 25;
  const result = $derived(response.result);
  const order = $derived(waitingGroupOrder(result.groups));
  const label = (name: string) =>
    ({ unassessed: "Unassessed", stale: "Stale assessment", conflict: "Conflicting", unknown: "Unknown impact" })[
      name
    ] ?? `Impact ${name}`;
</script>

<section class="pipeline-waiting" aria-labelledby="waiting-heading">
  <h2 id="waiting-heading">Waiting backlog by impact</h2>
  <p class="pipeline-note">
    Open, unclaimed tickets grouped by their latest valid impact assessment. Age is the time since
    a ticket was created; typical age is the median. Blocked tickets are also counted under Not
    ready. No impact is guessed: unassessed, stale, conflicting and unknown impact are separate
    groups.
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
      <caption>Unclaimed open tickets by impact</caption>
      <thead>
        <tr>
          <th scope="col">Impact</th>
          <th scope="col">Waiting</th>
          <th scope="col">Ready</th>
          <th scope="col">Blocked</th>
          <th scope="col">Not ready</th>
          <th scope="col">Readiness unknown</th>
          <th scope="col">Typical age</th>
          <th scope="col">Oldest</th>
          <th scope="col">Unknown age</th>
        </tr>
      </thead>
      <tbody>
        {#each order as name (name)}
          {@const g = result.groups[name]!}
          <tr>
            <th scope="row">{label(name)}</th>
            <td>{g.total.count}</td>
            <td>{g.ready.count}</td>
            <td>{g.blocked.count}</td>
            <td>{g.notReady.count}</td>
            <td>{g.unknown.count}</td>
            <td>{formatAge(g.age.medianMs)}</td>
            <td>{formatAge(g.age.oldestMs)}</td>
            <td>{g.age.unknownCount}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">All</th>
          <td>{result.totals.total.count}</td>
          <td>{result.totals.ready.count}</td>
          <td>{result.totals.blocked.count}</td>
          <td>{result.totals.notReady.count}</td>
          <td>{result.totals.unknown.count}</td>
          <td>{formatAge(result.totals.age.medianMs)}</td>
          <td>{formatAge(result.totals.age.oldestMs)}</td>
          <td>{result.totals.age.unknownCount}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  {#each order as name (name)}
    {@const g = result.groups[name]!}
    {#if g.total.count}
      <details class="pipeline-members">
        <summary>{label(name)}: {g.total.count} ticket{g.total.count === 1 ? "" : "s"}</summary>
        <ul>
          {#each g.total.members.slice(0, shown) as member (member)}
            {@const href = ticketLink(member)}
            <li>
              {#if href}<a {href}>{member}</a>{:else}{member}{/if}
              {#if g.ready.members.includes(member)}<span> (ready)</span>
              {:else if g.blocked.members.includes(member)}<span> (blocked)</span>
              {:else if g.notReady.members.includes(member)}<span> (not ready)</span>
              {:else}<span class="warn"> (readiness unknown)</span>{/if}
            </li>
          {/each}
        </ul>
        {#if g.total.members.length > shown}
          <p>{g.total.members.length - shown} more not listed.</p>
        {/if}
      </details>
    {/if}
  {/each}

  {#if result.claimUnknown.count}
    <p class="warn" role="status">
      Whether {result.claimUnknown.count} open ticket{result.claimUnknown.count === 1 ? " is" : "s are"} claimed
      or ready could not be established; {result.claimUnknown.count === 1 ? "it is" : "they are"} not in this
      backlog.
    </p>
  {/if}
  {#if result.stateUnknown.count}
    <p class="warn" role="status">
      Whether {result.stateUnknown.count} ticket{result.stateUnknown.count === 1 ? " is" : "s are"} open
      or closed could not be established; {result.stateUnknown.count === 1 ? "it is" : "they are"} not in this
      backlog.
    </p>
  {/if}
  <Freshness freshness={response.freshness} computedAt={result.observedAt} />
</section>
