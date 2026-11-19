<script lang="ts">
  import type { RulesRuleView } from "../../serve/rules-page.js";
  import RulesFormal from "./RulesFormal.svelte";

  let { rule, level = 3 }: { rule: RulesRuleView; level?: 3 | 4 } = $props();
</script>

<article class="rule-purpose" data-rule-id={rule.id}>
  {#if level === 4}
    <h4><code>{rule.id}</code></h4>
  {:else}
    <h3><code>{rule.id}</code></h3>
  {/if}
  {#if rule.purpose === null}
    <p class="warn">Purpose not supplied. Read the generated formal conditions below.</p>
  {:else}
    <p>{rule.purpose}</p>
  {/if}
  {#if rule.formal}
    <RulesFormal formal={{ label: `Formal conditions for ${rule.id}`, lines: rule.formal }} />
  {/if}
</article>
