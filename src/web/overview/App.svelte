<script lang="ts">
  import { onMount } from "svelte";
  import { itemLinks, kindLabel, newsHours, newsLoader, selection } from "./client.js";
  import type { NewsHours, NewsState } from "./client.js";
  import CurrentWork from "./CurrentWork.svelte";
  import DailyCounts from "./DailyCounts.svelte";
  import { dailyLoader, dailyWindow } from "./daily.js";
  import type { DailyDays, DailyState } from "./daily.js";
  import { workLoader } from "./work.js";
  import type { WorkState } from "./work.js";

  let { api, teamApi }: { api: string; teamApi: string } = $props();
  let work: WorkState = $state({ status: "loading" });
  let daily: DailyState = $state({ status: "loading" });
  let dailyDays: DailyDays = $state(7);
  let chooseDays = $state((_d: DailyDays) => {});
  const memberHref = (member: string) => {
    const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(member);
    if (!m) return null;
    const q = new URLSearchParams({ repo: m[1]!, n: m[2]! });
    const keep = new URLSearchParams(window.location.search);
    for (const k of ["role", "agent"]) {
      const v = keep.get(k);
      if (v) q.set(k, v);
    }
    return `/ticket?${q}`;
  };
  let repository: string | null = $state(null);
  const ticketHref = (n: number) => {
    const q = new URLSearchParams({ repo: repository ?? "", n: String(n) });
    const keep = new URLSearchParams(window.location.search);
    for (const k of ["role", "agent"]) {
      const v = keep.get(k);
      if (v) q.set(k, v);
    }
    return `/ticket?${q}`;
  };
  let state: NewsState = $state({ status: "loading" });
  let hours: NewsHours = $state(6);
  let refresh = $state(() => {});
  let choose = $state((_h: NewsHours) => {});
  const response = $derived(state.status === "ready" ? state.response : null);

  onMount(() => {
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    const loader = newsLoader(api, fetcher, (next) => {
      state = next;
    });
    const workRead = workLoader(teamApi, fetcher, (next) => {
      work = next;
    });
    const dailyRead = dailyLoader(api, fetcher, (next) => {
      daily = next;
    });
    refresh = () => {
      // The news read collects fresh metrics facts; the daily view then re-reads that cache only
      // after a complete read, and otherwise reads fresh itself.
      void loader.refresh().then((first) =>
        first?.status === "ready" && first.response.status === "complete"
          ? dailyRead.reload()
          : dailyRead.refresh(),
      );
      void workRead.refresh();
    };
    const load = () => {
      const sel = selection(window.location.search);
      hours = sel.hours;
      repository = sel.repository;
      void loader.load(sel);
      void workRead.load(sel.repository);
      dailyDays = dailyWindow(window.location.search);
      void dailyRead.load({ repository: sel.repository, days: dailyDays });
    };
    choose = (h) => {
      const url = new URL(window.location.href);
      url.searchParams.set("news", `${h}h`);
      window.history.pushState(null, "", url);
      load();
    };
    chooseDays = (d) => {
      const url = new URL(window.location.href);
      url.searchParams.set("days", `${d}d`);
      window.history.pushState(null, "", url);
      load();
    };
    load();
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  });
</script>

<section aria-labelledby="news">
  <h2 id="news">Recent news</h2>
  <div class="overview-actions">
    <fieldset class="window">
      <legend>Window</legend>
      {#each newsHours as h (h)}
        <label><input type="radio" name="news" value={h} checked={hours === h} onchange={() => choose(h)} /> {h} hour{h === 1 ? "" : "s"}</label>
      {/each}
    </fieldset>
    <button type="button" onclick={() => refresh()} disabled={state.status === "loading"}>Refresh</button>
    <p role="status" aria-live="polite">
      {#if state.status === "no-project"}
        Choose a project to see its news.
      {:else if state.status === "loading"}
        Loading the news…
      {:else if state.status === "error"}
        The news could not be loaded.
      {:else if response}
        {response.status === "incomplete" ? "Partial: " : ""}events from {response.window.from.slice(11, 16)} to {response.window.through.slice(11, 16)} UTC on {response.window.through.slice(0, 10)}{response.freshness ? `, observed ${response.freshness.observedAt}${response.freshness.stale ? " (stale)" : ""}` : ", observation time not supplied"}.
      {/if}
    </p>
  </div>
  <p class="explain">
    Ledger events in the window, newest first: tickets created, picked up and released, delivery
    records, PR merges, closures and reopenings, each linked to its ticket or pull request. Events
    from tickets whose history was only partly read may be missing, and are counted below.
  </p>

  {#if state.status === "error"}
    <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
  {:else if response}
    {#if response.coverageNote}<p class="warn">{response.coverageNote}</p>{/if}
    {#each response.warnings as w}<p class="warn">{w}</p>{/each}
    {#if response.incomplete.count}
      <p class="warn">{response.incomplete.count} ticket(s) were only partly read; their recent events may be missing.</p>
    {/if}
    {#if response.items.length === 0}
      <p>
        {response.status === "incomplete" || response.incomplete.count
          ? "No events were found, but the read was partial: there may be events not shown."
          : "No events in this window."}
      </p>
    {:else}
      <ol class="news-list">
        {#each response.items as item (item.key)}
          {@const links = itemLinks(item, window.location.search)}
          <li>
            <time datetime={item.at}>{item.at.slice(11, 16)} UTC</time>
            <span class="kind">{kindLabel(item.kind)}</span>
            {#if links.ticket}<a href={links.ticket.href}>{links.ticket.label}</a>{/if}
            {#if links.pr}<a href={links.pr.href}>{links.pr.label}</a>{/if}
            {#if item.detail && item.kind !== "pr-merged"}<span class="detail">{item.detail}</span>{/if}
          </li>
        {/each}
      </ol>
      {#if response.omitted}<p class="warn">{response.omitted} more event(s) in this window are not listed.</p>{/if}
    {/if}
  {/if}
</section>

<CurrentWork state={work} {ticketHref} />

<DailyCounts state={daily} days={dailyDays} choose={chooseDays} ticketHref={memberHref} />
