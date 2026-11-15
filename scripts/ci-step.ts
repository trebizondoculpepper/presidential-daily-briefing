/**
 * CI step wrapper (#393, doc/design/test-reporting.md): `tsx scripts/ci-step.ts NAME -- COMMAND...`
 * runs COMMAND with its output streamed unchanged, then records the exit code, duration and a
 * bounded output tail in `reports/steps/NAME.json` for the job summary, and exits with the
 * command's own code so the step passes or fails exactly as before.
 * Runtime: Node (current LTS) and tsx; Linux, macOS and Windows.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tailOf, type StepRecord } from "../src/ci/testreport.js";

const [name, separator, ...command] = process.argv.slice(2);
if (!name || !/^[\w.-]+$/.test(name) || separator !== "--" || !command.length) {
  process.stderr.write("Usage: tsx scripts/ci-step.ts NAME -- COMMAND [ARGS...]\n");
  process.exit(64);
}
const reports = process.env.PDB_REPORTS ?? "reports";
// Producers write their reports into this directory, so it exists before the command starts.
mkdirSync(join(reports, "steps"), { recursive: true });
const started = performance.now();
let output = "";
const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
  to.write(chunk);
  output = (output + chunk.toString("utf8")).slice(-65536);
};
// npm and npx are .cmd shims on Windows, which only a shell can start.
const child = spawn(command[0]!, command.slice(1), {
  shell: process.platform === "win32",
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.on("data", (c: Buffer) => keep(c, process.stdout));
child.stderr.on("data", (c: Buffer) => keep(c, process.stderr));
const record = (exitCode: number) => {
  const step: StepRecord = {
    step: name,
    command,
    exitCode,
    durationMs: Math.round(performance.now() - started),
    tail: tailOf(output),
  };
  mkdirSync(join(reports, "steps"), { recursive: true });
  writeFileSync(join(reports, "steps", `${name}.json`), JSON.stringify(step, null, 2) + "\n");
  process.exit(exitCode);
};
child.on("error", (error) => {
  output += `\n${name}: could not start ${command[0]}: ${error.message}\n`;
  record(127);
});
child.on("close", (code, signal) => record(code ?? (signal ? 128 : 1)));
