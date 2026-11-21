/**
 * Local-logging package check (#1017): one ordinary writer, for the concurrent-writer and
 * rotation checks in doc/research/local-logging.md. Run several at once against one directory:
 *   npx tsx doc/reports/examples/local-logging/writer.ts DIR TAG COUNT [MAX_SIZE]
 * Each record is one JSON line tagged with TAG; the process exits naturally once Winston has
 * drained, so the check never relies on a premature `finish` event.
 */
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const [dir, tag, count, maxSize] = process.argv.slice(2);
if (!dir || !tag || !count) throw new Error("usage: writer.ts DIR TAG COUNT [MAX_SIZE]");
const transport = new DailyRotateFile({
  dirname: dir,
  filename: "pdb-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  utc: true,
  maxFiles: "7d",
  maxSize: maxSize ?? "20m",
  auditFile: `${dir}/.pdb-audit.json`,
});
const log = winston.createLogger({ format: winston.format.json(), transports: [transport] });
for (let i = 0; i < Number(count); i++) log.info("e", { tag, i, pad: "x".repeat(200) });
log.end();
