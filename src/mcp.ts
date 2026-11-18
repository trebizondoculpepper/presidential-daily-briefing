#!/usr/bin/env node
import { resolveEffectiveHuman, disabledEffectiveHuman } from "./config/effectiveidentity.js";
import { humanContextEnabled } from "./config/humancontext.js";
import { createAppServices } from "./composition.js";
/**
 * The stdio `pdb-mcp` entry point (doc/design/mcp.md, #25). The server itself lives in
 * src/mcp/server.ts so that `pdb serve` can build the same server without loading this entry.
 */
import { realpathSync } from "node:fs";
import { initializeCrashes } from "./telemetry/crashes.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  bindPolling,
  createServer,
  defaultRuntime,
  mcpArguments,
  mcpHelp,
  prepareMcpIdentity,
} from "./mcp/server.js";
import { installedVersion } from "./updates/updates.js";

export * from "./mcp/server.js";

function isEntryPoint(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  await initializeCrashes(
    "mcp",
    fileURLToPath(new URL("../", import.meta.url)),
    (await installedVersion()).version,
  );
  try {
    const options = mcpArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(mcpHelp);
    else {
      const { version } = await installedVersion();
      // One shared typed Git and GH service for this process (#929, #870).
      const services = createAppServices();
      const runtime = defaultRuntime(options);
      if (!process.env.PDB_NO_EFFECTIVE_IDENTITY)
        await prepareMcpIdentity(
          options,
          runtime,
          {
            env: process.env,
            fs: runtime.fs,
            git: runtime.git ?? services.git,
            human: () =>
              humanContextEnabled()
                ? resolveEffectiveHuman((signal) => services.gh.account.current(signal))
                : Promise.resolve(disabledEffectiveHuman()),
          },
          (text) => {
            process.stderr.write(text);
          },
        );
      await bindPolling(options, runtime);
      const watcher = runtime.watcher;
      const handle = serveStdio(() => createServer(options, runtime, version ?? "0.0.0"), {
        onerror: (error) => process.stderr.write(`pdb-mcp: ${error.message}\n`),
      });
      if (watcher) {
        // Only this process owns the timer: EOF, disconnect or a signal stops it for good.
        const shutdown = () => watcher.stop();
        process.stdin.once("end", shutdown);
        process.stdin.once("close", shutdown);
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.once(signal, () => {
            shutdown();
            void handle.close().finally(() => process.exit(0));
          });
        watcher.start();
      }
    }
  } catch (error) {
    process.stderr.write(`pdb-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
