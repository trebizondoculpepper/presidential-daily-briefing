<script lang="ts">
  import { onMount } from "svelte";
  import { rulesLoader } from "./client.js";
  import type { RulesState as State } from "./client.js";
  import RulesState from "./RulesState.svelte";

  let { api }: { api: string } = $props();
  let state: State = $state({ status: "loading" });

  onMount(() => {
    const loader = rulesLoader(
      api,
      (input, init) => fetch(input, init),
      (next) => {
        state = next;
      },
    );
    void loader.load(window.location.search);
    // Back/forward changes the query: reload; the loader discards the superseded read.
    const reload = () => void loader.load(window.location.search);
    window.addEventListener("popstate", reload);
    return () => window.removeEventListener("popstate", reload);
  });
</script>

<RulesState {state} />
