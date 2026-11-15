# Four-page local public website (#600)

Implemented the reviewed #599 contract as TypeScript static content/renderer and
progressive TypeScript copy controls. Four routes share original terminal styling,
explicit no-release/no-capture preview labels, source links and keyboard semantics.
The preview runs no GitHub commands or agent sessions. No web runtime dependency is
added to the published CLI. #601 supplies validated released capture; #602 deploys.

Added focused route/escaping/provenance-boundary tests. Local preview HTTP checks
returned 200 on all four routes. Calculated foreground contrast against both dark
surfaces is at least 9.06:1. Narrow grid sizing and heading bounds are explicit.
These static checks do not establish visual, keyboard, zoom or clipboard behavior.

Browser QA is currently unavailable: CUA inventory reports browser access host
unavailable, and both Chrome app-name and bundle-ID attempts return cgWindowNotFound.
No visual screenshots or completed browser checks are claimed. Keep #600 open until
its required narrow/wide/zoom/copy/no-JS inspection is actually performed.
No TODO.md exists in this checkout. No DNS, hosting or npm publication was changed.
