<script lang="ts">
  import { onMount } from "svelte";
  import { inventoryLoader, selectedRepository } from "./client.js";
  import type { InventoryState } from "./client.js";
  import PipelineState from "./PipelineState.svelte";

  let { api }: { api: string } = $props();
  let state: InventoryState = $state({ status: "loading" });
  let refresh = $state(() => {});

  onMount(() => {
    const loader = inventoryLoader(
      api,
      (input, init) => fetch(input, init),
      (next) => {
        state = next;
      },
    );
    refresh = () => void loader.refresh();
    void loader.load(selectedRepository(window.location.search));
    const reload = () => void loader.load(selectedRepository(window.location.search));
    window.addEventListener("popstate", reload);
    return () => window.removeEventListener("popstate", reload);
  });
</script>

<div class="pipeline-actions">
  <button type="button" onclick={() => refresh()} disabled={state.status === "loading"}>
    Refresh
  </button>
</div>
<PipelineState {state} />
