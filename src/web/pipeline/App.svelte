<script lang="ts">
  import { onMount } from "svelte";
  import { inventoryLoader, selectedRepository, waitingLoader } from "./client.js";
  import type { InventoryState, WaitingState as Waiting } from "./client.js";
  import PipelineState from "./PipelineState.svelte";
  import WaitingState from "./WaitingState.svelte";

  let { api }: { api: string } = $props();
  let inventory: InventoryState = $state({ status: "loading" });
  let waiting: Waiting = $state({ status: "loading" });
  let refresh = $state(() => {});

  onMount(() => {
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    // One loader per section: each fails, loads and refreshes on its own.
    const sections = [
      inventoryLoader(api, fetcher, (next) => {
        inventory = next;
      }),
      waitingLoader(api, fetcher, (next) => {
        waiting = next;
      }),
    ];
    refresh = () => sections.forEach((s) => void s.refresh());
    const load = () => {
      const repository = selectedRepository(window.location.search);
      sections.forEach((s) => void s.load(repository));
    };
    load();
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  });
</script>

<div class="pipeline-actions">
  <button
    type="button"
    onclick={() => refresh()}
    disabled={inventory.status === "loading" || waiting.status === "loading"}
  >
    Refresh
  </button>
</div>
<PipelineState state={inventory} />
<WaitingState state={waiting} />
