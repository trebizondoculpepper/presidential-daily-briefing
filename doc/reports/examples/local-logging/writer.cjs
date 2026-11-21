// Two-writer check: argv[2]=dir argv[3]=tag argv[4]=n
const winston = require("winston");
require("winston-daily-rotate-file");
const [dir, tag, n] = [process.argv[2], process.argv[3], +process.argv[4]];
const t = new winston.transports.DailyRotateFile({
  dirname: dir,
  filename: "pdb-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  utc: true,
  maxFiles: "7d",
  maxSize: "20m",
  auditFile: dir + "/.pdb-audit.json",
  zippedArchive: false,
});
const log = winston.createLogger({ format: winston.format.json(), transports: [t] });
for (let i = 0; i < n; i++) log.info("e", { tag, i, pad: "x".repeat(200) });
log.end();
