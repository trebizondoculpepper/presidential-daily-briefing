<script lang="ts">
  import { onMount } from "svelte";
  import { configurationLoader } from "./client.js";
  import type { ConfigurationState } from "./client.js";
  import ConfigurationView from "./ConfigurationState.svelte";

  let { api }: { api: string } = $props();
  let state: ConfigurationState = $state({ status: "loading" });

  onMount(() => {
    const loader = configurationLoader(
      api,
      (input, init) => fetch(input, init),
      (next) => {
        state = next;
      },
    );
    const load = () => void loader.load(window.location.search);
    load();
    // Back/forward changes the query (and with it the selected project): reload; the loader
    // discards the superseded read.
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  });
</script>

<ConfigurationView {state} />
