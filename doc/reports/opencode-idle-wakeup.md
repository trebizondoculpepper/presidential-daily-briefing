# OpenCode idle wake-up: what the platform actually supports (#23)

Status: research report for #23, restricted to an agent running on OpenCode. It records platform
capability and a recommended adapter; it implements nothing and changes no configuration.

## Platform under test

| Item              | Value                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Client            | OpenCode `v2.3.0` (this session)                                                                |
| Plugin API in use | the V1-compatible plugin shape, proven by the installed `.opencode/plugins/agent-inbox-wake.js` |
| V2 API reference  | <https://opencode.ai/docs/build/plugins/server>, <https://opencode.ai/docs/build/plugins/cli>   |
| Primary evidence  | the installed mailbox wake plugin, which is running in this session                             |

The installed plugin is the strongest evidence available, because it is not a proposal: it is loaded
by this client and it wakes this session when mail arrives.

```js
// .opencode/plugins/agent-inbox-wake.js (installed by `agent-inbox install-hook`)
export const AgentInboxWake = async ({ client, $ }) => {
  let holding = false;
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      if (holding) return;
      holding = true;
      try {
        const run = await $`… python -m agent_inbox wake-check --event Stop --wait …`
          .nothrow()
          .quiet();
        const said = String(run.stderr ?? "").trim();
        if (run.exitCode === 2 && said) {
          await client.session.prompt({
            path: { id: event.properties.sessionID },
            body: { parts: [{ type: "text", text: said }] },
          });
        }
      } finally {
        holding = false;
      }
    },
  };
};
```

That is the whole mechanism: an idle event, a bounded external wait, and a prompt into the same
session. Everything below separates the four things the ticket asks not to conflate.

## 1. UI notification

A TUI plugin can raise a system notification, a sound, or both, and can decide by terminal focus:

```ts
await context.attention.notify({
  title: "PDB",
  message: "3 tickets need attention",
  notification: { when: "blurred" },
  sound: { name: "done", volume: 0.5, when: "always" },
});
```

`context.ui.toast.show({ message, variant, duration })` is the in-terminal equivalent. Both are
presentation only: they tell a human something happened and cannot start work. They are also
TUI-only, so a headless or remote session gets nothing.

## 2. Context injection on the next turn

Two mechanisms, with different semantics:

- `ctx.session.instructions.entry.put({ sessionID, key, value })` attaches a keyed instruction
  entry that renders as a `<context key="…">` block in the session's instructions. Updates and
  removals are announced at the next step boundary **without queuing a message turn**. This is the
  right shape for "here is standing context", not for "you have mail".
- `ctx.session.hook("prompt", …)` rewrites an incoming prompt before admission (text, files,
  metadata, delivery). It runs once per admission, not per model call, and is not an exactly-once
  side-effect boundary.

Neither starts a turn on its own. If the session is idle, context injection waits for the next
human turn.

## 3. Starting a new turn in an idle session

This is the capability the ticket is really about, and it exists:

- `ctx.event.subscribe({ types: ["session.idle"] })` (V2) or the V1 `event` handler delivers the
  idle event with the session id.
- `ctx.session.prompt({ sessionID, text })` admits a user-shaped turn into that session;
  `ctx.session.synthetic({ sessionID, text })` admits a synthetic message instead.

The installed mailbox plugin proves the V1 path end to end in this deployment. Two properties
matter for PDB:

- The injected text arrives as a **user turn**. It must therefore be treated as data, never as
  instructions, and it must be sanitized and bounded by the producer (the mailbox plugin passes
  only sender and subject, never a message body).
- The plugin must guard re-entry: the installed one holds a `holding` flag so a second idle event
  cannot start a second waiter, and it re-arms on timeout rather than spinning.

## 4. Interrupting an active turn

`ctx.session.interrupt({ sessionID, resume: false })` stops a running session. PDB's contract
requires that an explicit user stop wins, so an adapter must never call this to "make room" for a
wake-up, and must never treat an interrupted turn as a natural completion. There is no native
"natural stop" flag to read: the idle event is the only signal, and it fires for both a finished
turn and an idle-after-interrupt session. Distinguishing them needs evidence the platform does not
expose, so an adapter must not claim it.

## Recommended adapter (smallest implementation)

A thin OpenCode plugin, modelled on the mailbox one, with PDB policy kept out of it. It follows
[shared-rebrief-core.md](../design/shared-rebrief-core.md): only a verified natural end-of-turn
event is eligible, and explicit stop, cancellation, failure or an unknown reason stops before
contacting PDB.

1. Subscribe to `session.idle`, but **fail closed on provenance**. A bare idle event does not prove
   a natural end of turn: the platform fires it after an interrupt too. The adapter may proceed
   only when the harness supplies an explicit natural-stop signal (the same evidence the rebrief
   adapters require); with unknown provenance it stops and waits for the next eligible turn. This
   is why "do not call `session.interrupt`" is not enough by itself.
2. On an eligible idle, run one bounded PDB read (`pdb --json` or the MCP briefing) with a hard
   timeout and a re-entry guard; never a background watcher and never a second concurrent waiter.
3. Deduplicate **delivered work**, not just concurrent callbacks. Store a fingerprint of the
   actionable set (for example a hash of the ordered ticket numbers and their states) in plugin
   storage and skip the prompt when the fingerprint is unchanged since the last delivered prompt.
   The reference plugin's `holding` flag only excludes overlapping callbacks and keeps no such
   memory.
4. If the fingerprint changed and the read reports actionable work, call `session.prompt` with a
   short, sanitized summary (counts and ticket numbers, no bodies, no credentials, no paths) and
   record the new fingerprint.
5. If the read fails or times out, do nothing, keep the old fingerprint and re-arm on the next
   eligible turn. A failed read must never produce a prompt that claims work exists.
6. Never call `session.interrupt`, never approve a permission, never install a hook, and never
   change configuration.

This is a plugin, not a service: it lives only while the client runs, so "wake" means "the next
time this session ends a turn naturally", not "at 03:00 while the laptop sleeps".

## Limitations to state in any acceptance

- No wake while OpenCode is not running; no OS-level scheduler is involved.
- The idle event does not distinguish natural completion from an interrupted turn, so an adapter
  must fail closed unless the harness provides explicit natural-stop evidence.
- The injected turn is user-shaped, so the model may act on it; the producer must keep it factual
  and bounded.
- TUI notifications are unavailable in headless/remote sessions.
- V1-compatible plugins and the V2 plugin API differ; an adapter must pick one and say which.

## Owner test steps

1. With OpenCode running in a PDB checkout, install the adapter plugin under `.opencode/plugins/`.
2. Let the session go idle with no actionable work: expect no prompt.
3. Create or claim a ticket that makes the briefing actionable, then let the session go idle:
   expect one prompt naming the ticket, and no second prompt for the same state.
4. Interrupt a running turn with actionable work present: expect **no** wake-up prompt, because
   the stop provenance is unknown.
5. Let the same unchanged work cause two natural ends of turn: expect one prompt, not two
   (delivered-work deduplication). Change the work, end a turn: expect exactly one new prompt.
6. Stop OpenCode, change the repository, restart: expect the next eligible turn to reflect the new
   state, with no queued duplicate.

## Recommendation

Ship the plugin adapter described above as the OpenCode half of the idle-wake work, with the
mailbox plugin as the reference implementation. Keep PDB's policy in PDB: the plugin only asks
"is there work?" and reports the answer. Do not build a daemon, do not add a native stop flag, and
do not let the adapter interrupt or approve anything.
