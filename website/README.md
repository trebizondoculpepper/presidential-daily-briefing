# Public website source (#600)

Local-only implementation of `doc/design/public-website.md`. No web runtime dependencies
are added to the distributed CLI. The existing npm package `files` allowlist excludes
this directory. Content, rendering and browser behavior use TypeScript; CSS is static.

Run `npm run website:preview:build` from the repository root. Output is ignored under
`dist/website`. Serve that directory with a local static server; all four routes and
relative assets work without an origin-root assumption. JavaScript only enhances copying.
No release output is invented: the preview labels itself and displays a no-capture state.

`site.ts` exports a presentation-only `renderSite(SiteInput)` returning relative paths
and HTML strings. #601 must validate exact released-artifact provenance, sanitize terminal
controls and exposure risks, and adapt its validated capture to this presentation input.
The renderer HTML-escapes all text. Command element IDs are internally generated, and
content cannot supply links or markup. This interface is not release verification.
#602 owns hosting/DNS, post-release workflows and publication. No deployment occurs here.
