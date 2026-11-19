<script lang="ts">
  import type { RulesState } from "./client.js";
  import RulesPage from "./RulesPage.svelte";

  let { state }: { state: RulesState } = $props();
</script>

{#if state.status === "loading"}
  <p role="status">Loading the rules…</p>
{:else if state.status === "error"}
  <p class="error" role="alert">{state.message}</p>
  <p>The same document is available from <code>pdb rules</code>.</p>
{:else if state.status === "empty"}
  <p class="warn" role="status">
    No rules match this view.
    <a href={state.response.selected ? `/rules?repo=${encodeURIComponent(state.response.selected)}` : "/rules"}>Show every rule</a>.
  </p>
{:else}
  <RulesPage response={state.response} />
{/if}
