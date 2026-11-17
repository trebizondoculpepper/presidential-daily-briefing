# Running-process footer acceptance (#730)

Implementation follows doc/design/served-shell-followups.md. No running user
server, global install, credentials, live tickets or client trust settings were
changed during validation.

- Focused component checks: executing-package provenance versus source checkout,
  explicit unknown version/revision/dirty state, immutable startup values, HTML
  escaping, existing safety text preserved in one footer and no dead Doctor link.
- HTTP integration with fake auth/clock/build metadata: Work, Ticket, Rules,
  Setup, Quotas, Human, Activity and invalid-project HTML carry the same identity.
  Status reports matching build fields; HEAD remains bodyless and CSP unchanged.
- Optional public IP parsing rejects private/loopback/documentation/nonliteral
  input. Production makes no external discovery request and cannot mistake the
  listener address for a public address.
- Full check, 2,541 passed tests (one existing skip), build/help and the existing
  installed-package suite passed. Browser assets remain self-contained.
- Real headless Chrome rendered a synthetic account-wide Quotas page at 1280x1000
  and 390x1100. Exact device metrics verified inner width and document scroll width
  both 390; the footer wrapped within the content area. The selector remained above
  navigation. Source revision and dirty state in these screenshots were explicitly
  injected synthetic values, not claims about a released build.

The browser automation host was unavailable, so visual checks used a disposable
headless Chrome profile instead; screenshots were inspected locally. No user
browser profile was read. This is visual/layout evidence, not VoiceOver testing;
#719 remains separate. Doctor is not implemented/linked by this change. A missing
source build manifest remains unknown rather than being inferred from current Git
or npm latest; installed package gitHead is used only for an actual package install.

Morning integration with main through 3f935f7 retained the new effective identity
startup and status fields alongside process provenance. Check, the combined suite
(2,685 passed, one existing skip), and build passed after conflict resolution.
