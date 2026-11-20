<script lang="ts">
  import { seriesMembers, ticketLink, volumeAverage, volumeCell } from "./client.js";
  import type { AssessmentResponse } from "./client.js";

  let { response }: { response: AssessmentResponse } = $props();
  /** Members listed per drill-down; the rest are counted, never silently dropped. */
  const shown = 25;
  const result = $derived(response.result);
  const impact = $derived(result.metrics.impact);
  const complexity = $derived(result.metrics.complexity);
  /** New tickets are counted once, not per metric: the incoming series is the same for both. */
  const incoming = $derived(impact.volume.incoming);
  const columns = $derived([
    { id: "incoming", label: "New tickets", figure: incoming },
    { id: "impact", label: "First impact assessments", figure: impact.volume.firstAssessed },
    { id: "complexity", label: "First complexity assessments", figure: complexity.volume.firstAssessed },
  ]);
  const days = $derived(incoming.series.days.map((d) => d.day));
</script>

<section class="pipeline-volume" aria-labelledby="volume-heading">
  <h2 id="volume-heading">Assessment pace</h2>
  <p class="pipeline-note">
    New tickets per day next to the tickets that received their first impact or complexity
    assessment that day, for the last {result.days} days (UTC). Each column counts tickets once:
    a reassessment is not a new assessment, and the two metrics are not added together. A day is
    "unknown" when its history could not be read completely; what was seen is shown but not used as
    a count. Averages are over known days only.
  </p>
  {#if response.status !== "complete"}
    <p class="warn" role="status">Incomplete read: some figures may be missing.</p>
  {/if}
  {#if result.coverage.note}
    <p class="warn" role="status">{result.coverage.note}</p>
  {/if}
  {#each columns as c (c.id)}
    {#if c.figure.lowerBound || c.figure.incomplete.count}
      <p class="warn" role="status">
        {c.label}: {c.figure.incomplete.count} ticket{c.figure.incomplete.count === 1 ? "" : "s"}
        could not be dated, so these counts are a lower bound.
      </p>
      {#if c.figure.incomplete.members.length}
        <!-- The tickets behind that count; they are not in the dated "in this window" lists. -->
        <details class="pipeline-members">
          <summary>
            {c.label}: {c.figure.incomplete.members.length} undated ticket{c.figure.incomplete
              .members.length === 1
              ? ""
              : "s"}
          </summary>
          <ul>
            {#each c.figure.incomplete.members.slice(0, shown) as member (member)}
              {@const href = ticketLink(member)}
              <li>{#if href}<a {href}>{member}</a>{:else}{member}{/if}</li>
            {/each}
          </ul>
          {#if c.figure.incomplete.members.length > shown}
            <p>{c.figure.incomplete.members.length - shown} more not listed.</p>
          {/if}
        </details>
      {/if}
    {/if}
  {/each}

  <div class="pipeline-table-scroll">
    <table class="pipeline-table">
      <caption>Daily new tickets and first assessments (UTC days)</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          {#each columns as c (c.id)}<th scope="col">{c.label}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each days as day (day)}
          <tr>
            <th scope="row"><time datetime={day}>{day}</time></th>
            {#each columns as c (c.id)}<td>{volumeCell(c.figure, day)}</td>{/each}
          </tr>
        {/each}
        <tr>
          <th scope="row">
            <time datetime={incoming.series.partial.day}>{incoming.series.partial.day}</time> so far
            (through
            <time datetime={incoming.series.partial.observedThrough}
              >{incoming.series.partial.observedThrough}</time
            >)
          </th>
          {#each columns as c (c.id)}<td>{c.figure.series.partial.observed}</td>{/each}
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Average per known day</th>
          {#each columns as c (c.id)}<td>{volumeAverage(c.figure)}</td>{/each}
        </tr>
      </tfoot>
    </table>
  </div>
  <p class="pipeline-note">
    Reassessments in this window (assessment records that replaced an earlier size; events, not
    tickets): impact {impact.revisions.inWindow}{impact.revisions.lowerBound ? " or more" : ""},
    complexity {complexity.revisions.inWindow}{complexity.revisions.lowerBound ? " or more" : ""}.
  </p>

  {#each columns as c (c.id)}
    {@const members = seriesMembers(c.figure)}
    {#if members.length}
      <details class="pipeline-members">
        <summary>{c.label}: {members.length} ticket{members.length === 1 ? "" : "s"} in this window</summary>
        <ul>
          {#each members.slice(0, shown) as member (member)}
            {@const href = ticketLink(member)}
            <li>{#if href}<a {href}>{member}</a>{:else}{member}{/if}</li>
          {/each}
        </ul>
        {#if members.length > shown}
          <p>{members.length - shown} more not listed.</p>
        {/if}
      </details>
    {/if}
  {/each}
</section>
