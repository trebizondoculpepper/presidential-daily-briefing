# #1027 rules.md from the shared English policy

`pdb onboard` in a verified checkout now writes two files: `rules.md`, generated from the same
compiled English document `pdb rules` prints, and the managed `AGENTS.md` section, which now points
at it. `--install` stays as an alias and `--dry-run` previews both files without touching the tree.

Two decisions carried the weight. The generated file is guarded by a marker holding only the policy
identity — version, `rulesHash`, English model version — and deliberately **not** a generation time.
The contract asks for a dated snapshot _and_ for a repeated run to be a no-op; a timestamp makes
those two requirements fight, so the policy identity became the version stamp and the header says
the file is a snapshot rather than the authority. The first version of this did include a timestamp,
and the repeat-run test caught it: the second run rewrote `rules.md` instead of keeping it.

The other decision is that a hand-written `rules.md` is refused, never overwritten, and the refusal
is reported per file without blocking the `AGENTS.md` write — a partial outcome, stated as such,
with exit 1. Symbolic links are refused for the same reason the coordination section refuses them.
