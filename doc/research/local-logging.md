# Bounded logging package check

Date: 18 November 2026. Scope: documentation/metadata and a small source check,
not a benchmark or completed cross-platform feasibility trial.

The owner requests conventional logging with minimal research and authorizes a
new dependency. The starting stack is Winston with winston-daily-rotate-file.
Its [upstream documentation](https://github.com/winstonjs/winston-daily-rotate-file)
provides daily filename patterns, UTC dates, `maxFiles: '7d'`, size rotation and
error events. npm metadata reports Winston 3.19.0 and the transport 5.0.0, both MIT.
The transport's file-stream-rotator dependency owns retention/rotation; its audit
catalogue tracks managed files and does not delete unrelated files.

Important limit: the transport 5.0.0 `log()` implementation queues a stream write,
emits `logged` and invokes its callback immediately. That callback does not prove
file completion. Its `close()` uses the underlying stream's end callback and emits
`finish`; the adapter must verify an appropriate bounded lifecycle barrier or use
an equivalent standard acknowledged sink before force relies on it. Do not infer
fsync durability. This is why the facade distinguishes best-effort logs from an
awaited audit-write result.

A brief check of rotating-file-stream and streamroller metadata/docs did not
establish equivalent age-based retention: count-based backup retention is not the
owner's seven-day requirement. This was not an empirical comparison and does not
exclude either package if the implementer establishes a simple standard solution.

Remaining integration checks: idle/startup expiry, concurrent processes sharing
managed logs/catalogues, newline integrity, and acknowledged error/flush behavior.
No package is claimed to have passed those checks yet. The implementer may choose
an equivalent maintained stack without reopening product decisions; keep the
check bounded and avoid bespoke rotation/pruning. The
[logging contract](../design/local-logging.md) is the acceptance source.
