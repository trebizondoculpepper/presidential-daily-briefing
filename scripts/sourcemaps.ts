#!/usr/bin/env node
/**
 * Post-build step for the shipped source maps (#629, doc/design/sentry-crash-reporting.md
 * "Packaged stack locations"). Every map in dist/ must name only public, package-relative
 * `../src/` sources: an absolute or machine-specific path (a build directory, a home folder)
 * fails the build instead of shipping. Embedded source text is removed; the maps carry
 * positions only, which is all crash-frame mapping needs.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";
const publicSource =
  /^\.\.\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:ts|js|json)$/;

const maps = (await readdir(dist)).filter((f) => f.endsWith(".mjs.map"));
if (maps.length === 0) throw new Error(`No source maps in ${dist}; build with --sourcemap.`);
for (const name of maps) {
  const path = join(dist, name);
  const map = JSON.parse(await readFile(path, "utf8")) as {
    version?: unknown;
    sources?: unknown;
    sourceRoot?: unknown;
    sourcesContent?: unknown;
  };
  if (map.version !== 3 || !Array.isArray(map.sources))
    throw new Error(`${path} is not a version 3 source map.`);
  if (map.sourceRoot !== undefined && map.sourceRoot !== "")
    throw new Error(`${path} sets a sourceRoot; shipped maps must be package-relative.`);
  const foreign = map.sources.filter((s) => typeof s !== "string" || !publicSource.test(s));
  if (foreign.length)
    throw new Error(
      `${path} names ${foreign.length} source(s) outside ../src/, e.g. ${JSON.stringify(foreign[0])}.`,
    );
  delete map.sourcesContent;
  await writeFile(path, JSON.stringify(map));
  console.log(`ok   ${path}: ${map.sources.length} public sources, no embedded source text`);
}
