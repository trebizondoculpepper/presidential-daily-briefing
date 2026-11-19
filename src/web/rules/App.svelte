<script lang="ts">
  import { onMount, tick } from "svelte";
  import { revealFragment, rulesLoader } from "./client.js";
  import type { RulesState as State } from "./client.js";
  import RulesState from "./RulesState.svelte";

  let { api }: { api: string } = $props();
  let state: State = $state({ status: "loading" });
  let revealed = false;

  onMount(() => {
    const loader = rulesLoader(
      api,
      (input, init) => fetch(input, init),
      (next) => {
        state = next;
        // Once, after the first rendered rules: honour a fragment the bootstrap could not.
        if (next.status === "ready" && !revealed) {
          revealed = true;
          void tick().then(() =>
            revealFragment(window.location.hash, (id) => document.getElementById(id)),
          );
        }
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
