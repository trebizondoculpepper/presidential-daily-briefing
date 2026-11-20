<script lang="ts">
  import type { WorkState } from "./work.js";
  import { claimStatus } from "./work.js";

  /** Current work (#825): what each agent holds now, from the existing team read. */
  let { state, ticketHref }: { state: WorkState; ticketHref: (n: number) => string } = $props();
  const response = $derived(state.status === "ready" ? state.response : null);
</script>

<section aria-labelledby="current-work">
  <h2 id="current-work">Current work</h2>
  <p class="explain">
    Observed now, separately from the news above: each agent's claimed tickets with their verified
    activity or supplied wait reason and linked pull requests, and the delivery work they remain
    responsible for after submitting. A claim is not proof of activity, and agent presence is
    unknown. Stalled work is classified on the Pipeline page, not here.
  </p>
  {#if state.status === "loading"}
    <p role="status">Loading current work…</p>
  {:else if state.status === "error"}
    <p class="error" role="alert">{state.message}{state.code ? ` (${state.code})` : ""} Use Refresh to try again.</p>
  {:else if response}
    <p class="section-status">
      {response.status === "incomplete" ? "Partial: " : ""}{response.observedAt ? `observed ${response.observedAt}.` : "observation time not supplied."}
      Presence: {response.presence}.
    </p>
    {#each response.warnings as w}<p class="warn">{w}</p>{/each}
    {#if response.agents.length === 0}
      <p>{response.status === "incomplete" ? "No claims or responsibilities were found, but the read was partial." : "No agent holds a claim or delivery responsibility."}</p>
    {:else}
      <ul class="work-agents">
        {#each response.agents as a (a.agent)}
          <li>
            <h3>{a.agent}</h3>
            {#if a.claims.length}
              <ul>
                {#each a.claims as c (c.url)}
                  <li>
                    <a href={ticketHref(c.number)}>#{c.number} {c.title}</a>
                    <span class="status">({claimStatus(c)})</span>
                    {#each c.pullRequests as p (p.url)}
                      <span class="pr"><a href={p.url}>PR #{p.number}</a>{p.draft ? " draft" : ""}{p.ready ? " ready" : p.blockers.length ? `: ${p.blockers.join("; ")}` : ""}</span>
                    {/each}
                  </li>
                {/each}
              </ul>
            {/if}
            {#if a.responsibilities.length}
              <p class="resp-label">Still responsible for:</p>
              <ul>
                {#each a.responsibilities as r (r.url + (r.deliverable ?? ""))}
                  <li>
                    <a href={ticketHref(r.number)}>#{r.number}</a>
                    {r.scope === "deliverable" && r.deliverable ? ` ${r.deliverable}` : " (the ticket)"}{r.followUp ? ` (follow-up: ${r.followUp})` : ""}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
