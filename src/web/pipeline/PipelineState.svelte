<script lang="ts">
  import type { InventoryState } from "./client.js";
  import Inventory from "./Inventory.svelte";

  let { state }: { state: InventoryState } = $props();
</script>

{#if state.status === "no-project"}
  <p class="warn" role="status">Choose a project above to see its pipeline.</p>
{:else if state.status === "loading"}
  <p role="status">Loading the inventory…</p>
{:else if state.status === "error"}
  <p class="error" role="alert">{state.message}</p>
{:else}
  <Inventory response={state.response} />
{/if}
