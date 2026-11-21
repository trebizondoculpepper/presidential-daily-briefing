/**
 * Local-logging package check (#1017): one acknowledged audit write. A dedicated transport is
 * created for the record, and the write counts as acknowledged only when the rotator's stream
 * closes with no `error`: its end callback alone fired before EACCES on an unwritable directory.
 *   npx tsx doc/reports/examples/local-logging/audit-ack.ts DIR [COUNT]
 * Prints ACK, or FAILED:<code>, then exits immediately, proving nothing acknowledged was pending.
 */
import DailyRotateFile from "winston-daily-rotate-file";

/** Winston's formatted-message key (triple-beam's MESSAGE), without importing a transitive package. */
const MESSAGE = Symbol.for("message");
const [dir, count] = process.argv.slice(2);
if (!dir) throw new Error("usage: audit-ack.ts DIR [COUNT]");

/** The rotator stream the transport writes to; the package keeps it on the instance. */
interface RotatorStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  on(event: "rotate" | "close", listener: () => void): void;
  end(): void;
}

const audit = (record: object): Promise<string> =>
  new Promise((resolve) => {
    const transport = new DailyRotateFile({
      dirname: dir,
      filename: "pdb-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      utc: true,
      maxFiles: "7d",
      auditFile: `${dir}/.pdb-audit.json`,
    });
    const stream = (transport as unknown as { logStream: RotatorStream }).logStream;
    let failed: string | null = null;
    stream.on("error", (error) => {
      failed = error.code ?? String(error);
    });
    // A UTC-midnight rollover between construction and the write opens a new file: the rotator
    // bubbles `close` from every stream, so wait until each stream opened here has closed, not
    // just the first (the old, empty one), before acknowledging (#1199 review).
    let open = 1;
    stream.on("rotate", () => {
      open += 1;
    });
    stream.on("close", () => {
      open -= 1;
      if (open === 0) resolve(failed ? `FAILED:${failed}` : "ACK");
    });
    transport.log?.(
      { level: "info", message: "audit", [MESSAGE]: JSON.stringify(record) },
      () => {},
    );
    stream.end();
  });

let last = "ACK";
for (let i = 0; i < Number(count ?? 1); i++) {
  last = await audit({ audit: true, i, pid: process.pid });
  if (last !== "ACK") break;
}
console.log(last);
process.exit(0);
