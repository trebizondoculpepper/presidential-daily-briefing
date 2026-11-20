<script lang="ts">
  import { formatAge } from "./client.js";
  import type { InventoryResponse } from "./client.js";

  let {
    freshness,
    computedAt,
  }: { freshness: InventoryResponse["freshness"]; computedAt: string } = $props();
</script>

<p class="pipeline-note">
  {#if freshness}
    Facts collected at <time datetime={freshness.observedAt}>{freshness.observedAt}</time>
    ({freshness.source === "live"
      ? "fresh read"
      : `${freshness.source}, ${formatAge(freshness.ageSeconds * 1000)} old`}{freshness.stale
      ? ", stale"
      : ""});
  {:else}
    Collection time not supplied;
  {/if}
  figures computed at <time datetime={computedAt}>{computedAt}</time>.
</p>
