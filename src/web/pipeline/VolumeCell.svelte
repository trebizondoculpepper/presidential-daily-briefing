<script lang="ts">
  import { ticketLink } from "./client.js";

  /** One table cell: its figure, and the tickets behind it in a keyboard-operable disclosure. */
  let { text, members, label }: { text: string; members: string[]; label: string } = $props();
  const shown = 25;
</script>

{#if members.length}
  <details class="pipeline-cell-members">
    <summary aria-label={`${label}: ${text}; show ${members.length} ticket${members.length === 1 ? "" : "s"}`}
      >{text}</summary
    >
    <ul>
      {#each members.slice(0, shown) as member (member)}
        {@const href = ticketLink(member)}
        <li>{#if href}<a {href}>{member}</a>{:else}{member}{/if}</li>
      {/each}
    </ul>
    {#if members.length > shown}<p>{members.length - shown} more not listed.</p>{/if}
  </details>
{:else}
  {text}
{/if}
