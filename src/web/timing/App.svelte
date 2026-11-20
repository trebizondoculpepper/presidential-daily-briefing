<script lang="ts">
  import { onMount } from "svelte";
  import {
    chartBars,
    formatDuration,
    latencyLoader,
    selection,
    ticketLink,
    timingDays,
    timingLoader,
  } from "./client.js";
  import type { LatencyState, TimingDays, TimingState } from "./client.js";

  let { api }: { api: string } = $props();
  let state: TimingState = $state({ status: "loading" });
  let impact: LatencyState = $state({ status: "loading" });
  let days: TimingDays = $state(7);
  let refresh = $state(() => {});
  let choose = $state((_d: TimingDays) => {});

  const response = $derived(state.status === "ready" ? state.response : null);
  const bars = $derived(response ? chartBars(response.groups) : []);
  /** Bar widths come from a fixed set of classes in 2% steps: the CSP allows no inline styles. */
  const step = (pct: number) => `w${Math.max(1, Math.min(50, Math.round(pct / 2)))}`;

  onMount(() => {
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    const loader = timingLoader(api, fetcher, (next) => {
      state = next;
    });
    const impactLoader = latencyLoader(api, "impact", fetcher, (next) => {
      impact = next;
    });
    // One fresh collection: the first section bypasses the cache, the other then re-reads it.
    refresh = () => void loader.refresh().then(() => impactLoader.reload());
    choose = (d) => {
      const url = new URL(window.location.href);
      url.searchParams.set("days", String(d));
      window.history.pushState(null, "", url);
      load();
    };
    const load = () => {
      const sel = selection(window.location.search);
      days = sel.days;
      void loader.load(sel);
      void impactLoader.load(sel);
    };
    load();
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  });
</script>

<div class="timing-actions">
  <fieldset class="window">
    <legend>Window</legend>
    {#each timingDays as d (d)}
      <label><input type="radio" name="days" value={d} checked={days === d} onchange={() => choose(d)} /> {d} days</label>
    {/each}
  </fieldset>
  <button type="button" onclick={() => refresh()} disabled={state.status === "loading"}>Refresh</button>
  <p role="status" aria-live="polite">
    {#if state.status === "no-project"}
      Choose a project to see its timing.
    {:else if state.status === "loading"}
      Loading the timing figures…
    {:else if state.status === "error"}
      The timing figures could not be loaded.
    {:else if response}
      {response.status === "incomplete" ? "Partial: " : ""}window {response.window.from.slice(0, 10)} to {response.window.through.slice(0, 16).replace("T", " ")}Z{response.freshness ? `, observed ${response.freshness.observedAt}${response.freshness.stale ? " (stale)" : ""}` : ""}.
    {/if}
  </p>
</div>

{#if state.status === "error"}
  <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
{/if}

{#if response}
  <section aria-labelledby="pickup-delivery">
    <h2 id="pickup-delivery">Pickup to delivery</h2>
    <p class="explain">
      From the earliest valid pickup (a trusted PDB claim or agent label) to the last required PR
      merge, including review and waiting time; a handoff never restarts the clock. Grouped by the
      latest valid complexity. Median first, with the mean and the number of completed tickets;
      p75 and p90 only for groups with at least 20 completed. Open work is a lower bound, and
      tickets whose endpoints are unknown are counted separately, never as zero.
    </p>
    <p class="explain">Cohort: <code>{response.cohort}</code></p>
    {#if response.coverageNote}<p class="warn">{response.coverageNote}</p>{/if}
    {#each response.warnings as w}<p class="warn">{w}</p>{/each}

    {#if response.groups.length === 0}
      <p>No tickets in this window.</p>
    {:else}
      {#if bars.length}
        <figure class="timing-chart">
          <figcaption>Median (bar) and mean (marker) pickup-to-delivery time by complexity. The table below has the same figures.</figcaption>
          <ul aria-hidden="true">
            {#each bars as bar (bar.name)}
              <li>
                <span class="label">{bar.name}</span>
                <span class="track">
                  <span class="bar {step(bar.medianPct)}"></span>
                  {#if bar.meanPct !== null}<span class="mean m{step(bar.meanPct)}"></span>{/if}
                </span>
                <span class="value">{formatDuration(bar.median)} (n={bar.completed})</span>
              </li>
            {/each}
          </ul>
        </figure>
      {:else}
        <p>No ticket in this window has a completed pickup-to-delivery time yet; see the counts below.</p>
      {/if}

      <table class="timing-table">
        <caption>Pickup to delivery by complexity</caption>
        <thead>
          <tr>
            <th scope="col">Complexity</th>
            <th scope="col">Median</th>
            <th scope="col">Mean</th>
            <th scope="col">Completed</th>
            <th scope="col">p75</th>
            <th scope="col">p90</th>
            <th scope="col">Still open (lower bound)</th>
            <th scope="col">Unknown</th>
            <th scope="col">Closed undelivered</th>
          </tr>
        </thead>
        <tbody>
          {#each response.groups as g (g.name)}
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

      {#each response.groups as g (g.name)}
        <details class="drill">
          <summary>{g.name}: the tickets behind these figures</summary>
          {#each [["Completed", g.stats.members.completed], ["Still open", g.stats.members.open], ["Unknown endpoints", g.stats.members.unknown], ["Closed undelivered", g.stats.members.closedUndelivered]] as [label, members]}
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
{/if}

{#if impact.status === "ready"}
  {@const r = impact.response}
  <section aria-labelledby="impact-latency">
    <h2 id="impact-latency">Creation to first impact assessment</h2>
    <p class="explain">
      From the issue's creation to its earliest trusted impact assessment record, for tickets
      first assessed in the window. Median first, with the mean and the number of completed
      tickets; p75 and p90 only with at least 20. A ticket whose creation or first assessment is
      missing, unread or out of order counts as unknown, never as zero. Only impact assessments
      are measured here.
    </p>
    {#if r.coverageNote}<p class="warn">{r.coverageNote}</p>{/if}
    {#each r.warnings as w}<p class="warn">{w}</p>{/each}
    <table class="timing-table">
      <caption>Creation to first impact assessment</caption>
      <thead>
        <tr>
          <th scope="col">Median</th>
          <th scope="col">Mean</th>
          <th scope="col">Completed</th>
          <th scope="col">p75</th>
          <th scope="col">p90</th>
          <th scope="col">Unknown</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{formatDuration(r.stats.median)}</td>
          <td>{formatDuration(r.stats.mean)}</td>
          <td>{r.stats.completed}</td>
          <td>{r.stats.p75 === null ? "n<20" : formatDuration(r.stats.p75)}</td>
          <td>{r.stats.p90 === null ? "n<20" : formatDuration(r.stats.p90)}</td>
          <td>{r.stats.unknown}</td>
        </tr>
      </tbody>
    </table>
    <details class="drill">
      <summary>The tickets behind these figures</summary>
      {#each [["Completed", r.stats.members.completed], ["Unknown", r.stats.members.unknown]] as [label, members]}
        {#if (members as string[]).length}
          <p>{label}:
            {#each members as string[] as m, i}{i ? ", " : ""}{#if ticketLink(m, window.location.search)}<a href={ticketLink(m, window.location.search)}>{m}</a>{:else}{m}{/if}{/each}
          </p>
        {/if}
      {/each}
    </details>
  </section>
{:else if impact.status === "error"}
  <p class="error" role="alert">Impact assessment latency could not be loaded: {impact.message}</p>
{:else if impact.status === "loading" && state.status !== "loading"}
  <p role="status">Loading impact assessment latency…</p>
{/if}
