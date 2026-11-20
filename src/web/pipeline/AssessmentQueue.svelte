<script lang="ts">
  import { assessmentOverlap, formatAge, ticketLink } from "./client.js";
  import type { AssessmentResponse } from "./client.js";
  import Freshness from "./Freshness.svelte";

  let { response }: { response: AssessmentResponse } = $props();
  /** Members listed per drill-down; the rest are counted, never silently dropped. */
  const shown = 25;
  const result = $derived(response.result);
  const metrics = [
    ["impact", "Impact"],
    ["complexity", "Complexity"],
  ] as const;
  const overlap = $derived(
    assessmentOverlap(
      result.metrics.impact.unassessed.members,
      result.metrics.complexity.unassessed.members,
    ),
  );
  const lists = $derived(
    metrics.flatMap(([key, label]) => {
      const m = result.metrics[key];
      return [
        { id: `${key}-unassessed`, title: `${label}: no assessment`, members: m.unassessed.members },
        { id: `${key}-stale`, title: `${label}: stale assessment`, members: m.states.stale.members },
        { id: `${key}-conflict`, title: `${label}: conflicting assessments`, members: m.states.conflict.members },
        { id: `${key}-unknown`, title: `${label}: assessment unknown`, members: m.states.unknown.members },
      ].filter((l) => l.members.length);
    }),
  );
</script>

<section class="pipeline-assessment" aria-labelledby="assessment-heading">
  <h2 id="assessment-heading">Assessment health</h2>
  <p class="pipeline-note">
    Open issues without a valid impact or complexity assessment, now. Impact and complexity are
    separate metrics; an issue missing both appears under each, so the rows are not added up.
    "No assessment" means no trusted estimate was recorded; stale, conflicting and unknown
    evidence are counted separately and are not treated as absent. Age is the time since the issue
    was created; typical age is the median.
  </p>
  {#if response.status !== "complete"}
    <p class="warn" role="status">Incomplete read: some figures may be missing.</p>
  {/if}
  {#each response.warnings as warning, i (i)}
    <p class="warn" role="status">{warning}</p>
  {/each}
  {#if result.coverage.note}
    <p class="warn" role="status">{result.coverage.note}</p>
  {/if}

  <div class="pipeline-table-scroll">
    <table class="pipeline-table">
      <caption>Open issues by assessment state</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">No assessment</th>
          <th scope="col">Typical age</th>
          <th scope="col">Oldest</th>
          <th scope="col">Unknown age</th>
          <th scope="col">Stale</th>
          <th scope="col">Conflicting</th>
          <th scope="col">Unknown</th>
        </tr>
      </thead>
      <tbody>
        {#each metrics as [key, label] (key)}
          {@const m = result.metrics[key]}
          <tr>
            <th scope="row">{label}</th>
            <td>{m.unassessed.count}</td>
            <td>{formatAge(m.unassessed.medianAgeMs)}</td>
            <td>{formatAge(m.unassessed.oldestAgeMs)}</td>
            <td>{m.unassessed.unknownAges}</td>
            <td>{m.states.stale.count}</td>
            <td>{m.states.conflict.count}</td>
            <td>{m.states.unknown.count}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="pipeline-note">
    {overlap.issues} distinct issue{overlap.issues === 1 ? " has" : "s have"} no assessment for at least
    one metric: {overlap.both} missing both, {overlap.impactOnly} missing impact only and
    {overlap.complexityOnly} missing complexity only.
  </p>

  {#each lists as list (list.id)}
    <details class="pipeline-members">
      <summary>{list.title}: {list.members.length} issue{list.members.length === 1 ? "" : "s"}</summary>
      <ul>
        {#each list.members.slice(0, shown) as member (member)}
          {@const href = ticketLink(member)}
          <li>{#if href}<a {href}>{member}</a>{:else}{member}{/if}</li>
        {/each}
      </ul>
      {#if list.members.length > shown}
        <p>{list.members.length - shown} more not listed.</p>
      {/if}
    </details>
  {/each}

  {#each metrics as [key, label] (key)}
    {@const unknownState = result.metrics[key].stateUnknown}
    {#if unknownState.count}
      <p class="warn" role="status">
        {label}: whether {unknownState.count} issue{unknownState.count === 1 ? " is" : "s are"} open could
        not be established; {unknownState.count === 1 ? "it is" : "they are"} not counted above.
      </p>
    {/if}
  {/each}
  <Freshness freshness={response.freshness} computedAt={result.window.through} />
</section>
