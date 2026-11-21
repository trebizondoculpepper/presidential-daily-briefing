<script lang="ts">
  import { averageText, cell, prHref } from "./daily.js";
  import type { DailyState } from "./daily.js";

  /** Daily merged pull requests (#827): PRs, never counted as delivered tickets. */
  let { state }: { state: DailyState } = $props();
  const s = $derived(state.status === "ready" ? state.response.prMerges : null);
</script>

<section aria-labelledby="pr-merges">
  <h2 id="pr-merges">Merged pull requests per day</h2>
  <p class="explain">
    Pull requests merged per UTC day, in the same window as the ticket counts above. These are PRs,
    not tickets: one ticket delivered by three PRs is three merges here and one delivery above. A day
    whose history was not read shows "unknown", never 0; today is partial and outside the
    complete-day average.
  </p>
  {#if state.status === "loading"}
    <p role="status">Loading merged pull requests…</p>
  {:else if state.status === "error"}
    <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
  {:else if state.status === "ready" && !s}
    <p class="warn">The server did not supply merged pull request counts.</p>
  {:else if s}
    <table class="daily-table">
      <caption>Merged pull requests per UTC day</caption>
      <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Merged PRs</th></tr></thead>
      <tbody>
        {#each s.days as d (d.day)}<tr><th scope="row">{d.day}</th><td>{cell(d)}</td></tr>{/each}
        <tr class="partial"><th scope="row">{s.partial.day} (today, partial)</th><td>{s.partial.observed} so far</td></tr>
      </tbody>
      <tfoot><tr><th scope="row">Complete-day average</th><td>{averageText(s)}</td></tr></tfoot>
    </table>
    {#if s.incomplete.count}<p class="warn">Merge evidence missing for {s.incomplete.count} ticket(s); counts are lower bounds.</p>{/if}
    <details class="drill">
      <summary>The pull requests behind each day</summary>
      {#each [...s.days, { day: `${s.partial.day} (today)`, members: s.partial.members }] as d (d.day)}
        {#if d.members.length}
          <p>{d.day}:
            {#each d.members as m, i}{i ? ", " : ""}{#if prHref(m)}<a href={prHref(m)}>{m}</a>{:else}{m}{/if}{/each}
          </p>
        {/if}
      {/each}
    </details>
  {/if}
</section>
