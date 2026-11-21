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

A bounded empirical check of Winston 3.19.0 with winston-daily-rotate-file 5.0.0 (file-stream-rotator 0.6.1) on macOS 27.2.1, Node v26.7.0. The harness is in [examples/local-logging](../reports/examples/local-logging/): `writer.ts` (one ordinary writer; `npx tsx doc/reports/examples/local-logging/writer.ts DIR TAG N [MAX_SIZE]`) and `audit-ack.ts` (acknowledged audit writes; `npx tsx doc/reports/examples/local-logging/audit-ack.ts DIR [COUNT]`). It used disposable directories and no secrets. Each result below was reproduced; this is not a cross-platform proof.

| Check                                                   | Result     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two concurrent processes, one daily file                | passes     | 2 × 20,000 records: 40,000 parsed, 0 corrupt lines; catalogue lists the one file                                                                                                                                                                                                                                                                                                                                            |
| Concurrent processes with size rotation (1 MiB cap)     | not proven | 2 × 20,000 and, three times over, 3 × 15,000: every record parsed, 0 corrupt, every rotated file catalogued in these runs. But each process keeps its own in-memory catalogue and rewrites the whole file (`writeFileSync`), so with staggered size rotation one process can overwrite another's entry for a `.N` file, which then escapes retention (#1199 review). These runs did not hit that race and do not exclude it |
| Age retention after inactivity                          | passes     | A catalogue with files 10, 8, 6 and 1 days old: the first write of a new UTC day removed the 10- and 8-day files and kept the 6- and 1-day files and an unrelated file. Expiry runs when a new file joins the catalogue (`addLogToAudit`), so cleanup happens at the next new-day write, not while no PDB process runs                                                                                                      |
| Catalogue integrity                                     | passes     | The package removes only catalogued files whose recorded hash verifies (`name + "LOG_FILE" + date`); a hand-edited or foreign entry is never deleted                                                                                                                                                                                                                                                                        |
| Rotation drops buffered data?                           | no         | The transport passes `end_stream: true`, so the rotator ends (not destroys) the old stream on rotation                                                                                                                                                                                                                                                                                                                      |
| Winston's `logged`/callback or Writable `finish` as ack | **unsafe** | Exiting on the transport's Writable `finish` lost all 40,000 records. The rotator's `write` also drops any callback. Neither proves a write                                                                                                                                                                                                                                                                                 |
| Stream end callback as ack                              | **unsafe** | On an unwritable directory the end callback fired **before** the `EACCES` error, a false acknowledgement                                                                                                                                                                                                                                                                                                                    |
| Acknowledged audit write (stream `close` with no error) | passes     | A dedicated transport per audit record, resolved on the rotator stream's `close` only if no `error` was seen: 600 audit records from two processes, each followed by an immediate `process.exit`, all present beside 20,000 concurrent ordinary records; an unwritable directory reports `EACCES` instead of an acknowledgement                                                                                             |

Proposed configuration (not yet accepted): Winston with winston-daily-rotate-file, `utc: true`, `datePattern: "YYYY-MM-DD"`, `maxFiles: "7d"` (days, from `logging.retentionDays`) and a catalogue file in the log directory. Ordinary events use one long-lived transport per process. The audit-required write uses a dedicated transport per audit record. It is acknowledged only when every stream opened for it has closed with no `error`: the harness counts a `rotate` during the write (a UTC-midnight rollover opens a new file, and the rotator bubbles `close` from both streams), so the old, empty stream's `close` cannot acknowledge the record (#1199 review; reasoned from the rotator source, not exercised at a real midnight). This uses the package's own lifecycle, not a second file writer, and promises no fsync durability.

Open decision (#1017): the package's catalogue is not multi-process safe. Each process keeps the catalogue in memory and rewrites the whole file, so a stale process can drop another's entry. Size rotation makes this likelier (per-process `.N` names), but daily-only files do not remove it either (#1199 review). A long-lived `pdb serve` that last wrote on day 1 can stay idle while CLI processes create day 2's file, then rewrite its day-1 catalogue on day 3 without day 2's entry, stranding that file. Neither configuration is proven under concurrent long-lived and short-lived processes. The options (accept occasional stranded files, let PDB own retention with owner approval, or substitute a package with directory-based retention) are put to the owner on #1017; the facade waits for that answer.
