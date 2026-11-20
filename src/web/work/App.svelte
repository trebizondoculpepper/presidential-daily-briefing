<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    detailLoader,
    focusAfter,
    queueLoader,
    reconcileOpen,
    selectedContext,
  } from "./client.js";
  import type { DetailState, QueueState, WorkContext, WorkRow } from "./client.js";

  let { api, ticketApi }: { api: string; ticketApi: string } = $props();
  let state: QueueState = $state({ status: "loading" });
  let context: WorkContext | null = $state(null);
  let open: Set<string> = $state(new Set());
  let details: Record<string, DetailState> = $state({});
  let announcement = $state("");
  let refresh = $state(() => {});
  let list: HTMLElement | undefined = $state();
  let refreshButton: HTMLButtonElement | undefined = $state();

  const rows = $derived(
    state.status === "ready" ? state.queue.rows : state.status === "error" ? (state.previous?.rows ?? []) : [],
  );
  const queue = $derived(
    state.status === "ready" ? state.queue : state.status === "error" ? state.previous : null,
  );
  const updating = $derived(state.status === "ready" && state.updating);

  const panelId = (row: WorkRow) => `detail-${encodeURIComponent(row.key).replace(/%/g, "_")}`;
  const domId = (row: WorkRow) => `row-${encodeURIComponent(row.key).replace(/%/g, "_")}`;

  let details$: ReturnType<typeof detailLoader> | null = null;

  /** Read one open row's detail; a result from an older context or refresh is discarded. */
  async function loadDetail(row: WorkRow) {
    if (!context || row.number === null || !details$) return;
    const c = context;
    const generation = details$.generation();
    details = { ...details, [row.key]: { status: "loading" } };
    const result = await details$.load(c, row.number);
    if (details$.current(c, generation) && open.has(row.key))
      details = { ...details, [row.key]: result };
  }

  function toggle(row: WorkRow) {
    // The expansion is committed first, so the panel and its loading status show at once and
    // several rows can be opened while their details are pending.
    const next = new Set(open);
    if (next.has(row.key)) {
      next.delete(row.key);
      open = next;
      return;
    }
    next.add(row.key);
    open = next;
    const d = details[row.key];
    if (!d || d.status === "error") void loadDetail(row);
  }

  onMount(() => {
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    details$ = detailLoader(ticketApi, fetcher);
    let before: WorkRow[] = [];
    const loader = queueLoader(api, fetcher, async (next, nextContext) => {
      const focusedKey = document.activeElement?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null;
      const contextChanged = JSON.stringify(nextContext) !== JSON.stringify(context);
      context = nextContext;
      if (contextChanged) {
        open = new Set();
        details = {};
        details$?.reset(nextContext);
      }
      state = next;
      if (next.status === "ready" && !next.updating) {
        const after = next.queue.rows;
        open = reconcileOpen(open, after);
        // Details from before this refresh are older evidence than the new list: re-read the
        // open rows that survived, and drop everything else.
        details$?.invalidate();
        details = {};
        for (const row of after) if (open.has(row.key)) void loadDetail(row);
        if (focusedKey) {
          const target = focusAfter(focusedKey, before, after);
          await tick();
          const el = target
            ? list?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(target)}"] button`)
            : refreshButton;
          el?.focus({ preventScroll: target === focusedKey });
        }
        before = after;
      } else if (next.status === "error") announcement = `Update failed: ${next.message}`;
    });
    refresh = () => void loader.refresh();
    const load = () => void loader.load(selectedContext(window.location.search));
    load();
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  });
</script>

<div class="work-actions">
  <button type="button" bind:this={refreshButton} onclick={() => refresh()} disabled={state.status === "loading" || updating}>
    Refresh
  </button>
  <p class="work-status" role="status" aria-live="polite">
    {#if state.status === "no-project"}
      Choose a project to see its work.
    {:else if state.status === "loading"}
      Loading the work list…
    {:else if updating}
      Updating… showing the list observed {queue?.freshness?.observedAt ?? "earlier"}.
    {:else if state.status === "error"}
      {state.previous ? "Update failed; showing the earlier list." : "The work list could not be loaded."}
    {:else if queue}
      {queue.status === "incomplete" ? "Partial: " : ""}{queue.shown} shown{queue.total !== null ? ` of ${queue.total}` : ""}{queue.freshness ? `, observed ${queue.freshness.observedAt}${queue.freshness.stale ? " (stale)" : ""}` : ""}.
    {/if}
  </p>
  <p class="visually-hidden" aria-live="polite">{announcement}</p>
</div>

{#if state.status === "error"}
  <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
{/if}
{#if queue?.warnings.length}
  <ul class="warnings" aria-label="Coverage warnings">
    {#each queue.warnings as warning}<li>{warning}</li>{/each}
  </ul>
{/if}

{#if state.status === "loading"}
  <ol class="work-list" aria-busy="true" aria-label="Work">
    {#each [1, 2, 3, 4] as n (n)}<li class="skeleton" aria-hidden="true"></li>{/each}
  </ol>
{:else if queue && rows.length === 0}
  <p>{queue.status === "incomplete" ? "No work could be shown from the partial read; unknown is not zero work." : "No work for this selection."}</p>
{:else if rows.length}
  <ol class="work-list" bind:this={list} aria-label="Work" aria-busy={updating}>
    {#each rows as row (row.key)}
      <li class="work-row" data-row-key={row.key} id={domId(row)}>
        <h2 class="work-title">
          <button
            type="button"
            aria-expanded={open.has(row.key)}
            aria-controls={panelId(row)}
            onclick={() => toggle(row)}
          >
            <span class="chevron" aria-hidden="true">{open.has(row.key) ? "▾" : "▸"}</span>
            {row.number !== null ? `#${row.number} ` : ""}{row.title}
          </button>
        </h2>
        <ul class="badges" aria-label="Actions">
          <li class="badge kind">{row.kind}</li>
          {#each row.ruleIds as rule}<li class="badge rule">{rule}</li>{/each}
        </ul>
        {#if row.why}<p class="why">{row.why}</p>{/if}
        <p class="evidence">
          {row.owners.length ? `Owners: ${row.owners.join(", ")}` : "No recorded owner"}{row.impact ? ` · impact ${row.impact}` : ""}{row.complexity ? ` · complexity ${row.complexity}` : ""}
        </p>
        <div class="detail" id={panelId(row)} hidden={!open.has(row.key)}>
          {#if open.has(row.key)}
            {@const d = details[row.key]}
            {#if row.nextCommand}<p>Next: <code>{row.nextCommand}</code></p>{/if}
            {#if row.labels.length}<p class="labels">Labels: {row.labels.join(", ")}</p>{/if}
            {#if row.number === null}
              <p>No ticket detail for this action.</p>
            {:else if !d || d.status === "loading"}
              <p role="status">Loading details…</p>
            {:else if d.status === "error"}
              <p class="error">{d.message} Collapse and expand to try again.</p>
            {:else}
              <p>{d.detail.state} · {d.detail.ownership ?? "ownership unknown"} · delivery {d.detail.delivery ?? "unknown"}</p>
              {#if d.detail.pullRequests.length}
                <p>PRs: {#each d.detail.pullRequests as pr, i}{i ? ", " : ""}<a href={pr.url}>#{pr.number}</a>{/each}</p>
              {/if}
              {#if d.detail.nextSteps.length}
                <ul>{#each d.detail.nextSteps as step}<li>{step.why}{#if step.command}{" "}<code>{step.command}</code>{/if}</li>{/each}</ul>
              {/if}
              {#if !d.detail.complete}<p class="warn">Partial detail: {d.detail.warnings.join(" ")}</p>{/if}
              <p><a href={d.detail.url}>Open on GitHub</a> · <a href={`/ticket?repo=${encodeURIComponent(context?.repository ?? "")}&n=${row.number}`}>Full ticket view</a></p>
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}
