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

/** Each page's built files; a page is served only when both of its files come from one place. */
const pages = [
  [
    ["/web/rules.js", "rules.js", "text/javascript; charset=utf-8"],
    ["/web/rules.css", "rules.css", "text/css; charset=utf-8"],
  ],
  [
    ["/web/pipeline.js", "pipeline.js", "text/javascript; charset=utf-8"],
    ["/web/pipeline.css", "pipeline.css", "text/css; charset=utf-8"],
  ],
  [
    ["/web/overview.js", "overview.js", "text/javascript; charset=utf-8"],
    ["/web/overview.css", "overview.css", "text/css; charset=utf-8"],
  ],
  [
    ["/web/timing.js", "timing.js", "text/javascript; charset=utf-8"],
    ["/web/timing.css", "timing.css", "text/css; charset=utf-8"],
  ],
  [
    ["/web/work.js", "work.js", "text/javascript; charset=utf-8"],
    ["/web/work.css", "work.css", "text/css; charset=utf-8"],
  ],
] as const;

/** The directories that may hold the built assets: the packaged dist, then a checkout's dist. */
const directories = (): URL[] => [
  new URL("./web/", import.meta.url),
  new URL("../../dist/web/", import.meta.url),
];

/**
 * Per page (#1141 review): the first directory with that page's complete JS/CSS pair. A page
 * missing a file is left out (it then says its assets are not built) without affecting others,
 * and one page's files are never combined across directories.
 */
export const readWebAssets: WebAssetReader = () => readWebAssetsFrom(directories());

/** `readWebAssets` over given directories, in preference order (tests pass temporary ones). */
export async function readWebAssetsFrom(dirs: readonly URL[]): Promise<Map<string, WebAsset>> {
  const assets = new Map<string, WebAsset>();
  for (const files of pages)
    for (const dir of dirs) {
      const found = new Map<string, WebAsset>();
      for (const [path, name, type] of files) {
        try {
          found.set(path, { type, body: await readFile(new URL(name, dir), "utf8") });
        } catch {
          // Absent here; this page may be complete in the next directory.
        }
      }
      if (found.size === files.length) {
        for (const [path, asset] of found) assets.set(path, asset);
        break;
      }
    }
  return assets;
}
