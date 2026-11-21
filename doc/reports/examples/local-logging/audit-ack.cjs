const winston = require("winston");
require("winston-daily-rotate-file");
const dir = process.argv[2];
const audit = () =>
  new Promise((resolve) => {
    const t = new winston.transports.DailyRotateFile({
      dirname: dir,
      filename: "pdb-%DATE%.log",
      utc: true,
      maxFiles: "7d",
      auditFile: dir + "/.pdb-audit.json",
    });
    let failed = null;
    t.logStream.on("error", (e) => {
      failed = e.code || String(e);
    });
    t.logStream.once("close", () => resolve(failed ? "FAILED:" + failed : "ACK"));
    t.log({ [Symbol.for("message")]: JSON.stringify({ audit: true }) }, () => {});
    t.logStream.end();
  });
audit().then((r) => {
  console.log(r);
  process.exit(0);
});
