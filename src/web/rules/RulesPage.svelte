<script lang="ts">
  import type { RulesResponse } from "./client.js";
  import RulesFormal from "./RulesFormal.svelte";
  import RulesRule from "./RulesRule.svelte";

  let { response }: { response: RulesResponse } = $props();
  const view = $derived(response.view);
  const filters = $derived(
    Object.entries(response.filters).filter((entry): entry is [string, string] => !!entry[1]),
  );
  const everyRule = $derived(
    response.selected ? `/rules?repo=${encodeURIComponent(response.selected)}` : "/rules",
  );
</script>

{#if response.selected === null}
  <p class="warn" role="status">
    No project selected; choose one above to see its effective settings. The policy below is the
    same for every project.
  </p>
{/if}
{#if view.effectivePolicy.state === "error"}
  <p class="error" role="alert">
    Project policy error: {view.effectivePolicy.reason}. {view.effectivePolicy.next.join(" ")}
  </p>
{/if}
{#if !view.scope.complete}
  <p class="warn" role="status">
    Filtered subset ({filters.map(([k, v]) => `${k} ${v}`).join(", ")}): not the complete rules.
    <a href={everyRule}>Show every rule</a>.
  </p>
{/if}

<dl class="identity rules-identity">
  <dt>Policy version</dt>
  <dd><code>{view.policy.policyVersion}</code></dd>
  <dt>Default rulesHash</dt>
  <dd><code>{view.policy.rulesHash}</code></dd>
  <dt>Bundled purpose revision</dt>
  <dd><code>{view.policy.narrationHash ?? "none: purposes not supplied"}</code></dd>
  <dt>Effective policy</dt>
  <dd>
    {#if view.effectivePolicy.state === "active"}
      default plus project preferences, <code>{view.effectivePolicy.effectiveRulesHash}</code>
    {:else if view.effectivePolicy.state === "disabled"}
      the shipped default only (project preferences disabled)
    {:else if view.effectivePolicy.state === "error"}
      <span class="error">error: project preferences are enabled but not in force</span>
    {:else}
      unknown
    {/if}
  </dd>
  {#if view.effectivePolicy.state === "active"}
    <dt>Project source format</dt>
    <dd>
      {view.effectivePolicy.formatVersion} (projection {view.effectivePolicy.projectionVersion})
    </dd>
    <dt>Project source revision</dt>
    <dd><code>{view.effectivePolicy.projectRulesHash}</code></dd>
  {/if}
  <dt>Sources</dt>
  <dd>
    {#each view.policy.sources as source, i (source)}{i ? ", " : ""}<code>{source}</code>{/each}
  </dd>
  <dt>English model</dt>
  <dd><code>{view.policy.englishModelVersion}</code></dd>
  <dt>Scope</dt>
  <dd>{view.scope.complete ? "complete" : "filtered subset"}</dd>
  <dt>Effective settings</dt>
  <dd>
    {view.effectiveSettings.status === "known"
      ? `known for ${view.effectiveSettings.repository}`
      : "unknown"}
  </dd>
</dl>

<aside aria-label="Purpose coverage">
  <p>
    Authored purposes: {view.narration.supplied} of {view.narration.total} rules in this view.
    {view.narration.scope}
  </p>
  <p>{view.narration.note}</p>
  {#if view.narration.missing.length}
    <p class="warn">
      Purpose not supplied for: {view.narration.missing.join(", ")}. Every generated rule remains
      available.
    </p>
  {/if}
</aside>

<nav aria-label="Sections">
  <ol class="toc">
    {#each view.sections as section, i (i)}
      <li><a href="#section-{i}">{section.title}</a></li>
    {/each}
  </ol>
</nav>

{#each view.sections as section, i (i)}
  <section id="section-{i}">
    <h2>{section.title}</h2>
    {#if section.kind === "text"}
      <pre class="rules">{section.lines.join("\n")}</pre>
    {:else if section.kind === "formal"}
      <RulesFormal formal={section.formal} />
    {:else if section.kind === "decisions"}
      <p class="formal-introduction">{section.introduction}</p>
      {#each section.bands as band (band.band)}
        <h3 class="rule-band">Band {band.band}</h3>
        {#each band.rules as rule (rule.id)}
          <RulesRule {rule} level={4} />
        {/each}
      {/each}
    {:else}
      {#if section.before}<RulesFormal formal={section.before} />{/if}
      {#each section.rules as rule (rule.id)}
        <RulesRule {rule} />
      {/each}
      {#if section.after}<RulesFormal formal={section.after} />{/if}
    {/if}
  </section>
{/each}

<footer>
  Read-only. Compiled from the packaged policy artifact and, when enabled, the project's
  <code>pdb.rules.edn</code>; the same document as
  <code>pdb rules{filters.map(([k, v]) => ` --${k} ${v}`).join("")}</code>. Loading this page makes
  no GitHub requests.
</footer>
