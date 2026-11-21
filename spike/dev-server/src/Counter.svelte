<script lang="ts">
  import { counter } from "./store.svelte.js";
</script>

<button onclick={() => counter.count++}>clicked {counter.count} times — spike</button>
