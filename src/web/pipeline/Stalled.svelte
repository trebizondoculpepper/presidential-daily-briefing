<script lang="ts">
  import { stalledRows, ticketLink } from "./client.js";
  import type { InventoryResponse } from "./client.js";

  let { response }: { response: InventoryResponse } = $props();
  /** Tickets listed per group; the rest are counted, never silently dropped. */
  const shown = 25;
  const stalled = $derived(response.result.stalled);
  const groups = [
    ["knownWait", "Known wait", "The claim records a wait, for example on a human answer or a dependency."],
    ["blocked", "Blocked", "An open native blocker holds the ticket."],
    ["noRecordedProgress", "No recorded progress", "No event and no recorded reason in the threshold."],
    ["unknownActivity", "Activity unknown", "Activity or wait evidence could not be read completely."],
  ] as const;
</script>

<section class="pipeline-stalled" aria-labelledby="stalled-heading">
  <h2 id="stalled-heading">Work with no recorded progress</h2>
  <p class="pipeline-note">
    Claimed, unfinished tickets with no recorded event in the last {stalled.thresholdHours} hours
    (since <time datetime={stalled.cutoff}>{stalled.cutoff}</time>). This is what was recorded, not
    whether anyone is online: a known wait is separate from unexplained gaps, and nothing here
    releases a claim, changes an assignment, clears a blocker or closes work.
  </p>
  {#each groups as [bucket, label, help] (bucket)}
    {@const rows = stalledRows(stalled, bucket)}
    <h3>{label}: {stalled[bucket].count}</h3>
    <p class="pipeline-note">{help}</p>
    {#if rows.length}
      <div class="pipeline-table-scroll">
        <table class="pipeline-table">
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Agent</th>
              <th scope="col">Human owner</th>
              <th scope="col">Last recorded activity</th>
              <th scope="col">Wait reason</th>
            </tr>
          </thead>
          <tbody>
            {#each rows.slice(0, shown) as { member, detail } (member)}
              {@const href = ticketLink(member)}
              <tr>
                <th scope="row">{#if href}<a {href}>{member}</a>{:else}{member}{/if}</th>
                <td>{detail?.agent ?? "unknown"}</td>
                <td>
                  {#if !detail || detail.humanOwners === null}unknown
                  {:else if detail.humanOwners.length}{detail.humanOwners.join(", ")}
                  {:else}none{/if}
                </td>
                <td>
                  {#if detail?.lastActivityAt}<time datetime={detail.lastActivityAt}>{detail.lastActivityAt}</time>
                  {:else}none recorded{/if}
                </td>
                <td>{detail?.waitReason ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if rows.length > shown}<p>{rows.length - shown} more not listed.</p>{/if}
    {/if}
  {/each}
</section>
