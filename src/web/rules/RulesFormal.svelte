<script lang="ts">
  import type { RulesFormalView } from "../../serve/rules-page.js";

  let { formal }: { formal: RulesFormalView } = $props();
</script>

<details class="rule-formal">
  <summary>{formal.label}</summary>
  <pre class="rules">{formal.lines.join("\n")}</pre>
</details>
