<script lang="ts">
  import type { ConfigurationState as State } from "./client.js";

  let { state }: { state: State } = $props();

  const valueText = (value: unknown): string => {
    if (value === undefined || value === null) return "(unset)";
    if (Array.isArray(value)) return value.length ? JSON.stringify(value) : "(none)";
    if (typeof value === "string") return value;
    return String(value);
  };
</script>

{#if state.status === "loading"}
  <p role="status">Loading configuration…</p>
{:else if state.status === "error"}
  <p class="error" role="alert">{state.message}</p>
  <p>The same data is available from <code>/api/v1/configuration</code>.</p>
{:else}
  {#if state.response.view.state !== "ok"}
    <p class="warn" role="status">
      {state.response.view.state === "unsupported"
        ? "This scope has no local configuration file to read."
        : "The configuration file exists but could not be read; registered defaults are shown."}
    </p>
  {/if}
  <p class="configuration-context">
    {state.response.view.scope === "global" ? "Global (no project selected)" : `Project ${state.response.view.repository}`}
    {#if state.response.view.path}— <code>{state.response.view.path}</code>{/if}
  </p>
  <table class="configuration">
    <caption>Registered settings for the {state.response.view.scope} scope</caption>
    <thead>
      <tr>
        <th scope="col">Key</th>
        <th scope="col">Type</th>
        <th scope="col">Value</th>
        <th scope="col">Source</th>
        <th scope="col">Default</th>
        <th scope="col">Description</th>
      </tr>
    </thead>
    <tbody>
      {#each state.response.view.rows as row (row.key)}
        <tr>
          <th scope="row"><code>{row.key}</code></th>
          <td>{row.type}</td>
          <td>{valueText(row.value)}</td>
          <td>{row.source}</td>
          <td>{valueText(row.defaultValue)}</td>
          <td>{row.description}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if state.response.view.warnings.length}
    <ul class="configuration-warnings">
      {#each state.response.view.warnings as warning}
        <li>{warning}</li>
      {/each}
    </ul>
  {/if}
{/if}
