<script lang="ts">
  import { averageText, cell, complexityCell, dailyDays, ticketSeries } from "./daily.js";
  import type { DailyDays, DailyState } from "./daily.js";

  /** Daily ticket progress (#826): four separate series, never one productivity total. */
  let {
    state,
    days,
    choose,
    ticketHref,
  }: {
    state: DailyState;
    days: DailyDays;
    choose: (d: DailyDays) => void;
    ticketHref: (member: string) => string | null;
  } = $props();
  const response = $derived(state.status === "ready" ? state.response : null);
  const groups = $derived(
    response
      ? [...new Set(ticketSeries.flatMap(([n]) => Object.keys(response.series[n].byComplexity)))]
      : [],
  );
</script>

<section aria-labelledby="daily-progress">
  <h2 id="daily-progress">Daily ticket progress</h2>
  <fieldset class="window">
    <legend>Window</legend>
    {#each dailyDays as d (d)}
      <label><input type="radio" name="daily-days" value={d} checked={days === d} onchange={() => choose(d)} /> {d} days</label>
    {/each}
  </fieldset>
  <p class="explain">
    Per UTC day: tickets verified delivered (dated by their last required merge), tickets attested,
    tickets closed as completed without verified delivery, and tickets closed as not planned. They are
    separate series and are never added into one total. A known day with no events shows 0; a day
    whose history was not read shows "unknown". Today is partial and is left out of the
    complete-day averages. Complexity is the latest valid assessment, with unassessed and unknown as
    their own groups.
  </p>
  {#if state.status === "loading"}
    <p role="status">Loading daily counts…</p>
  {:else if state.status === "error"}
    <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
  {:else if response}
    <p class="section-status">
      {response.status === "incomplete" ? "Partial: " : ""}{response.observedAt ? `observed ${response.observedAt}.` : "observation time not supplied."}
    </p>
    {#if response.coverageNote}<p class="warn">{response.coverageNote}</p>{/if}
    {#each response.warnings as w}<p class="warn">{w}</p>{/each}
    {#if response.deliveredDateUnknown.count}
      <p class="warn">{response.deliveredDateUnknown.count} delivered ticket(s) have no reliable delivery date and are not in any day.</p>
    {/if}
    <table class="daily-table">
      <caption>Tickets per UTC day</caption>
      <thead>
        <tr>
          <th scope="col">Day (UTC)</th>
          {#each ticketSeries as [, label]}<th scope="col">{label}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each response.series.deliveries.days.map((d) => d.day) as dayName, i (dayName)}
          <tr>
            <th scope="row">{dayName}</th>
            {#each ticketSeries as [name]}
              <td>{cell(response.series[name].days[i]!, response.series[name].lowerBound)}</td>
            {/each}
          </tr>
        {/each}
        <tr class="partial">
          <th scope="row">{response.series.deliveries.partial.day} (today, partial)</th>
          {#each ticketSeries as [name]}<td>{response.series[name].partial.observed} so far</td>{/each}
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Complete-day average</th>
          {#each ticketSeries as [name]}<td>{averageText(response.series[name])}</td>{/each}
        </tr>
      </tfoot>
    </table>
    {#if groups.length}
      <table class="daily-table">
        <caption>Tickets in the window by complexity</caption>
        <thead>
          <tr>
            <th scope="col">Complexity</th>
            {#each ticketSeries as [, label]}<th scope="col">{label}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each groups as g (g)}
            <tr>
              <th scope="row">{g}</th>
{#each ticketSeries as [name]}<td>{complexityCell(response.series[name], g)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if groups.length}
      <details class="drill">
        <summary>The tickets behind each complexity count</summary>
        {#each groups as g (g)}
          {#each ticketSeries as [name, label]}
            {@const members = response.series[name].byComplexity[g]?.members ?? []}
            {#if members.length}
              <p>{g}, {label.toLowerCase()}:
                {#each members as m, i}{i ? ", " : ""}{#if ticketHref(m)}<a href={ticketHref(m)}>{m}</a>{:else}{m}{/if}{/each}
              </p>
            {/if}
          {/each}
        {/each}
      </details>
    {/if}
    {#each ticketSeries as [name, label]}
      {@const s = response.series[name]}
      <details class="drill">
        <summary>{label}: the tickets behind each day</summary>
        {#each [...s.days, { day: `${s.partial.day} (today)`, members: s.partial.members }] as d (d.day)}
          {#if d.members.length}
            <p>{d.day}:
              {#each d.members as m, i}{i ? ", " : ""}{#if ticketHref(m)}<a href={ticketHref(m)}>{m}</a>{:else}{m}{/if}{/each}
            </p>
          {/if}
        {/each}
        {#if s.incomplete.count}<p class="warn">Evidence missing for: {s.incomplete.members.join(", ")} (counts are lower bounds).</p>{/if}
      </details>
    {/each}
  {/if}
</section>
