<script lang="ts">
  import type { WaitingState } from "./client.js";
  import WaitingImpact from "./WaitingImpact.svelte";

  let { state }: { state: WaitingState } = $props();
</script>

{#if state.status === "no-project"}
  <p class="warn" role="status">Choose a project above to see its backlog.</p>
{:else if state.status === "loading"}
  <p role="status">Loading the backlog…</p>
{:else if state.status === "error"}
  <p class="error" role="alert">{state.message}</p>
{:else}
  <WaitingImpact response={state.response} />
{/if}
