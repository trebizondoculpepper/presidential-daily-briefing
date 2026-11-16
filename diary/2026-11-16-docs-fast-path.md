# Documentation-only CI fast path

The owner requested a focused CI PR to avoid full runtime verification for prose-only changes.
Markdown-only PRs outside executable examples get formatting verification; mixed changes,
configuration, fixtures, executable content and main pushes keep the full matrix. The stable
verify check fails closed when classification or the selected verification path fails.
Automated review requirements remain unchanged.
