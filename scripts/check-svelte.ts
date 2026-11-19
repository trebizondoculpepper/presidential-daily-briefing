/**
 * Component check for `npm run check` (#853): compiles every Svelte component in src/web with
 * the build's compiler and fails on any error or warning (syntax, accessibility, unused state).
 *
 * svelte-check is not used: it requires TypeScript 5 or 6 and this project uses TypeScript 7.
 * Component scripts are therefore kept to presentation; API parsing, loading and other logic
 * live in plain TypeScript modules (e.g. src/web/rules/client.ts) that `tsc` checks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compile } from "svelte/compiler";

const root = join(import.meta.dirname, "..", "src", "web");
const components = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return components(path);
    return name.endsWith(".svelte") ? [path] : [];
  });

let problems = 0;
const files = components(root);
for (const file of files) {
  const name = relative(process.cwd(), file);
  try {
    const { warnings } = compile(readFileSync(file, "utf8"), {
      filename: file,
      generate: "client",
      css: "external",
    });
    for (const w of warnings) {
      problems++;
      console.error(`${name}:${w.start?.line ?? "?"}: ${w.code}: ${w.message}`);
    }
  } catch (error) {
    problems++;
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (problems) {
  console.error(`Svelte check: ${problems} problem(s) in ${files.length} component(s).`);
  process.exit(1);
}
console.log(`Svelte check: ${files.length} component(s) compiled with no warnings.`);
