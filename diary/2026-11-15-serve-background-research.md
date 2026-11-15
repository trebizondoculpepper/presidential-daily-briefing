# Temporary background launch research (#552)

Completed the owner's release request first: official workflow 43698025635 published
0.9.0 from c36e42c, with matching npm latest/gitHead and GitHub tag/release verified
after registry propagation. Then researched the manually started, no-autostart lifetime.

Read primary Node, systemd-run and Microsoft docs plus the host launchctl manual.
Five credential-free disposable parent-death probes passed on this macOS host; each
cleaned up its own worker/runtime files. No IDE, live server, credentials, startup
registration or production service changed. The report distinguishes that limited
probe from real IDE/session/OS acceptance and recommends a small native launcher
before considering transient supervisor adapters.
