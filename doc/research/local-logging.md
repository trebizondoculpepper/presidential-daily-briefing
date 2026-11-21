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

## Integration check (21 November 2026, #1017)

A bounded empirical check of Winston 3.19.0 with winston-daily-rotate-file 5.0.0 (file-stream-rotator 0.6.1) on macOS 27.2.1, Node v26.7.0. The harness is in [examples/local-logging](../reports/examples/local-logging/): `writer.cjs` (one ordinary writer; `node writer.cjs DIR TAG N`) and `audit-ack.cjs` (one acknowledged audit write; `node audit-ack.cjs DIR`). It used disposable directories and no secrets. Each result below was reproduced; this is not a cross-platform proof.

| Check                                                   | Result     | Evidence                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two concurrent processes, one daily file                | passes     | 2 × 20,000 records: 40,000 parsed, 0 corrupt lines; catalogue lists the one file                                                                                                                                                                                                                                                |
| Concurrent processes with size rotation (1 MiB cap)     | passes     | 2 × 20,000 and, three times over, 3 × 15,000: every record parsed, 0 corrupt, every rotated file catalogued (none stranded). The size cap is per process, so concurrent files can exceed it; no record is lost                                                                                                                  |
| Age retention after inactivity                          | passes     | A catalogue with files 10, 8, 6 and 1 days old: the first write of a new UTC day removed the 10- and 8-day files and kept the 6- and 1-day files and an unrelated file. Expiry runs when a new file joins the catalogue (`addLogToAudit`), so cleanup happens at the next new-day write, not while no PDB process runs          |
| Catalogue integrity                                     | passes     | The package removes only catalogued files whose recorded hash verifies (`name + "LOG_FILE" + date`); a hand-edited or foreign entry is never deleted                                                                                                                                                                            |
| Rotation drops buffered data?                           | no         | The transport passes `end_stream: true`, so the rotator ends (not destroys) the old stream on rotation                                                                                                                                                                                                                          |
| Winston's `logged`/callback or Writable `finish` as ack | **unsafe** | Exiting on the transport's Writable `finish` lost all 40,000 records. The rotator's `write` also drops any callback. Neither proves a write                                                                                                                                                                                     |
| Stream end callback as ack                              | **unsafe** | On an unwritable directory the end callback fired **before** the `EACCES` error, a false acknowledgement                                                                                                                                                                                                                        |
| Acknowledged audit write (stream `close` with no error) | passes     | A dedicated transport per audit record, resolved on the rotator stream's `close` only if no `error` was seen: 600 audit records from two processes, each followed by an immediate `process.exit`, all present beside 20,000 concurrent ordinary records; an unwritable directory reports `EACCES` instead of an acknowledgement |

Decision: keep Winston with winston-daily-rotate-file, configured with `utc: true`, `datePattern: "YYYY-MM-DD"`, `maxFiles: "7d"` (days, from `logging.retentionDays`), `maxSize: "20m"` and a catalogue file in the log directory. Ordinary events use one long-lived transport per process. The audit-required write uses a dedicated transport per audit record and resolves only on the rotator stream's `close` without an `error`. This uses the package's own lifecycle, not a second file writer. As the contract says, it does not promise fsync durability. Midnight rollover is the package's UTC date pattern; the facade tests inject the clock around it.
