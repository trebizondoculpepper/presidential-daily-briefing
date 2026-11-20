<script lang="ts">
  import { onMount } from "svelte";
  import {
    commentText,
    discussionLoader,
    discussionScopes,
    scopeText,
    selection,
  } from "./client.js";
  import type { DiscussionScope, DiscussionState } from "./client.js";

  let { api }: { api: string } = $props();
  let state: DiscussionState = $state({ status: "loading" });
  let scope: DiscussionScope = $state("open");
  let repository: string | null = $state(null);
  let refresh = $state(() => {});
  let choose = $state((_s: DiscussionScope) => {});

  const response = $derived(state.status === "ready" ? state.response : null);
  const items = $derived(response?.items ?? []);

  onMount(() => {
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    const loader = discussionLoader(api, fetcher, (next) => {
      state = next;
    });
    const load = () => {
      const sel = selection(window.location.search);
      repository = sel.repository;
      scope = sel.scope;
      void loader.load(sel.repository, sel.scope);
    };
    refresh = () => void loader.refresh(repository, scope);
    choose = (next) => {
      const url = new URL(window.location.href);
      url.searchParams.set("state", next);
      window.history.pushState(null, "", url);
      load();
    };
    load();
    window.addEventListener("popstate", load);
    return () => {
      window.removeEventListener("popstate", load);
      loader.cancel();
    };
  });
</script>

<div class="discussion-actions">
  <fieldset class="scope">
    <legend>Scope</legend>
    {#each discussionScopes as s (s)}
      <label
        ><input
          type="radio"
          name="state"
          value={s}
          checked={scope === s}
          onchange={() => choose(s)}
        />
        {s}</label
      >
    {/each}
  </fieldset>
  <button type="button" onclick={() => refresh()} disabled={state.status === "loading"}>
    Refresh
  </button>
  <p role="status" aria-live="polite">
    {#if state.status === "no-project"}
      Choose a project to see its most discussed issues.
    {:else if state.status === "loading"}
      Loading the discussion list…
    {:else if state.status === "error"}
      The discussion list could not be loaded.
    {:else if response}
      {response.status === "incomplete" ? "Partial: " : ""}{scopeText(response.scope)} Showing
      {response.shown} of {response.shown + response.omitted} ranked issue{response.shown +
        response.omitted ===
      1
        ? ""
        : "s"}{response.freshness
        ? `, observed ${response.freshness.observedAt}${response.freshness.stale ? " (stale)" : ""}`
        : ""}.
    {/if}
  </p>
</div>

<p class="explain">
  Comment volume is a rough proxy for review: it is not proof of disagreement and never an
  implementation blocker. The order is the server's native ranking; this page does not re-sort it.
  Closed issues stay visible in the selected scope.
</p>

{#if state.status === "error"}
  <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""}</p>
{/if}

{#if response}
  {#if response.coverage.note}
    <p class="warn">{response.coverage.note}</p>
  {/if}
  {#if response.warnings.length}
    <ul class="warn">
      {#each response.warnings as warning (warning)}<li>{warning}</li>{/each}
    </ul>
  {/if}
  {#if items.length === 0}
    <p class="empty" role="status">No issues with recorded discussion in this scope.</p>
  {:else}
    <table class="discussion">
      <caption>Issues ranked by comment count (server order)</caption>
      <thead>
        <tr><th scope="col">#</th><th scope="col">Issue</th><th scope="col">Comments</th></tr>
      </thead>
      <tbody>
        {#each items as row (row.number)}
          <tr>
            <td>{row.rank}</td>
            <th scope="row">
              <a href={row.url}>{row.title}</a>
              {#if row.state === "CLOSED"}<span class="state"> (closed)</span>{/if}
              {#if row.why}<span class="why">{row.why}</span>{/if}
            </th>
            <td>{commentText(row.comments)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if response.omitted > 0}
      <p class="explain">
        {response.omitted} further issue{response.omitted === 1 ? " is" : "s are"} ranked by the
        server but not shown at this page limit. Raise <code>limit</code> on
        <code>/api/v1/discussion</code> to see more.
      </p>
    {/if}
  {/if}
  {#if response.unknown.length}
    <section class="unknown">
      <h2>Comment counts not read</h2>
      <p class="explain">
        These issues were in scope but their comment counts could not be read, so they are unknown
        rather than zero and were not ranked.
      </p>
      <ul>
        {#each response.unknown as row (row.number)}
          <li><a href={row.url}>{row.title}</a></li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}
