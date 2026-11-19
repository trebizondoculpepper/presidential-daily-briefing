# Rules page on the API-first Svelte boundary (#853)

Moved the Rules page from server-generated HTML to a versioned `/api/v1/rules` read plus a
Svelte component. `readRules` is now the one shared read; the page, the API and the tests all
go through it. The component reproduces the old markup structure, so the existing parity
tests (every CLI section and line appears on the page) still run, now against Svelte's
server render.

The official plugin works with the installed Vite+ (Vite 8.3.5 underneath). `svelte-check`
does not: it pins TypeScript 5 or 6 against our TypeScript 7, so the component check compiles
each component with warnings as errors and keeps logic in `tsc`-checked modules. Svelte
escapes only `&` and `<` in text, which is safe but differs from the old server escaper; two
tests were adjusted to that.

The packed-install smoke now proves `/rules`, `/api/v1/rules` and both built assets work from
an installed package with no source tree. Two other consumers that scraped `/rules` HTML (the
project-rules serve test and the package project-parity check) now read the API instead.
