/**
 * Built frontend assets served by `pdb serve` (#853, doc/design/serve-api-first-frontend.md).
 *
 * `npm run build` compiles the Svelte components in src/web into a fixed set of files in
 * dist/web; the package ships them. At startup the server reads them once from beside the running
 * module (the packaged dist) or, in a source checkout, from its built dist. It never reads src/
 * or compiles components at runtime. A missing build serves no asset rather than a stale one.
 */
import { readFile } from "node:fs/promises";

export interface WebAsset {
  type: string;
  body: string;
}
/** Reads the built assets as `published path -> asset`; tests inject their own. */
export type WebAssetReader = () => Promise<Map<string, WebAsset>>;

const files = [
  ["/web/rules.js", "rules.js", "text/javascript; charset=utf-8"],
  ["/web/rules.css", "rules.css", "text/css; charset=utf-8"],
] as const;

/** The directories that may hold the built assets: the packaged dist, then a checkout's dist. */
const directories = (): URL[] => [
  new URL("./web/", import.meta.url),
  new URL("../../dist/web/", import.meta.url),
];

export const readWebAssets: WebAssetReader = async () => {
  for (const dir of directories()) {
    const found = new Map<string, WebAsset>();
    for (const [path, name, type] of files) {
      try {
        found.set(path, { type, body: await readFile(new URL(name, dir), "utf8") });
      } catch {
        // Absent here; try the next directory.
      }
    }
    if (found.size === files.length) return found;
  }
  return new Map();
};
