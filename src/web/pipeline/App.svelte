<script lang="ts">
  import { onMount } from "svelte";
  import {
    assessmentLoader,
    inventoryLoader,
    refreshSections,
    selectedRepository,
    waitingLoader,
  } from "./client.js";
  import type {
    AssessmentState as Assessment,
    InventoryState,
    WaitingState as Waiting,
  } from "./client.js";
  import AssessmentState from "./AssessmentState.svelte";
  import PipelineState from "./PipelineState.svelte";
  import WaitingState from "./WaitingState.svelte";

  let { api }: { api: string } = $props();
  let inventory: InventoryState = $state({ status: "loading" });
  let waiting: Waiting = $state({ status: "loading" });
  let assessment: Assessment = $state({ status: "loading" });
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
      assessmentLoader(api, fetcher, (next) => {
        assessment = next;
      }),
    ];
    // One fresh collection shared by both sections (#1142 review).
    refresh = () => void refreshSections(sections);
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
    disabled={inventory.status === "loading" ||
      waiting.status === "loading" ||
      assessment.status === "loading"}
  >
    Refresh
  </button>
</div>
<PipelineState state={inventory} />
<WaitingState state={waiting} />
<AssessmentState state={assessment} />
