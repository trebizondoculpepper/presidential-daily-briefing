<script lang="ts">
  import type { AssessmentState } from "./client.js";
  import AssessmentQueue from "./AssessmentQueue.svelte";

  let { state }: { state: AssessmentState } = $props();
</script>

{#if state.status === "no-project"}
  <p class="warn" role="status">Choose a project above to see its assessment health.</p>
{:else if state.status === "loading"}
  <p role="status">Loading assessment health…</p>
{:else if state.status === "error"}
  <p class="error" role="alert">{state.message}</p>
{:else}
  <AssessmentQueue response={state.response} />
{/if}
