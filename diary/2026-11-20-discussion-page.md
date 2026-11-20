# #1103 Discussion page

A small API-first page at `/discussion` for the shared controversial-items view. The backend was
already there (#1099/#1102): `/api/v1/discussion` returns the native-ranked items, the unknown
comment counts, the state scope and the coverage note. So this is page work — a client that parses
that envelope, a scope selector for open/closed/all, and a table that shows the server's order
unchanged, with the comment counts and the GitHub links.

Two details were easy to get wrong and are now covered by tests. A malformed item rejects the whole
response instead of rendering a shorter list that looks like the server's answer, and a superseded
read never overwrites the newer one. The page also keeps a separate section for issues whose comment
counts were unread: unknown, never zero, never ranked.

The served page needed three registrations that are easy to miss: the build entry
(`vite.web.config.ts`, `scripts/build-web.ts`), the packaged files (`package.json`, the archive
allowlist in `scripts/package-test.ts`) and `src/serve/webassets.ts`, which is the list the server
actually reads at startup. Without the last one the route returns 200 with the "assets are not
built" text, which is what the first live check showed before it was added.
