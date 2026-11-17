# GPL distribution options for the DataScript dependency

Research for #787, checked 2026-11-17 against main `49f6233`. This report compares
paths for #634; it grants no permission and makes no license, dependency or release
change. GPL-3.0-or-later and the desired contributor naming are already owner
choices. The unresolved question is the distribution/rights boundary.

## Verified repository and upstream facts

- `package.json` pins runtime dependency `datascript` **1.8.1**; the lock agrees.
  Project `LICENSE` and package metadata are still MIT. No GPL change has shipped
  merely because the owner selected it.
- `third-party/datascript-LICENSE` is byte-identical to the
  [upstream 1.8.1 license](https://github.com/tonsky/datascript/blob/1.8.1/LICENSE),
  SHA-256 `22e0ff3e946377a65cede42300b894ab228488194b1474412bb305a68327b4f0`.
  Tag 1.8.1 resolves to `34915cf673c02cbc64779fe56e0288d70fea63f8`.
  It is EPL-1.0 with no additional GPL-compatible grant in that license file.
- `src/rules/datalog/engine.ts` imports DataScript at runtime and uses `init_db`
  and `q`. The project-rule worker resolves the same package in
  `src/rules/datalog/project/worker.ts`. Build-time compilation and tests also
  depend on its query semantics. Packaged Datalog chunks in the installed source
  build retain the dependency reference; this is not merely a test-only tool.
- `third-party/README.md` records the unmodified upstream package/source notice.
  `package.json` includes `third-party` in package files; the installed-package
  check lists the license explicitly. Retain those notices under every option.

The [Eclipse EPL FAQ, question 32](https://www.eclipse.org/legal/epl/faq/#GPLCOMPATIBLE)
describes EPL-1.0/GPL incompatibility for combinations considered derived/based-on
works, and addresses linking. PDB's actual runtime integration makes that guidance
relevant. This is evidence against simply changing the root license to plain GPL
and declaring clearance; determining the legal classification and rights of a
particular distribution still needs review.

EPL-1.0's later-version clause is **not an automatic GPL escape hatch**. The
[FSF license list](https://www.gnu.org/licenses/license-list.html#EPL2) explains
that EPL-2.0 without its designated GPL secondary license remains incompatible.
[EPL-2.0 section 3.2 and Exhibit A](https://www.eclipse.org/legal/epl-2.0/)
require the initial contributor's secondary-license notice; including the license
text alone does not establish that designation. This check found no such grant in
the pinned license; it did not obtain or assume an upstream permission.

## Options and approximate engineering cost

These sizes estimate technical work, excluding legal review, consent and waiting.
None is a production implementation ticket or permission to contact outsiders.

| Path                                                     | Feasibility and consequence                                                                                                                                                                                                                     | Engineering estimate                                                                       | Required evidence/decision                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applicable upstream compatible grant/permission          | Keeps the existing engine and semantics. Possible only if the appropriate rights holders actually grant terms covering the relevant code/distribution; no such grant was established here.                                                      | S to document/package a sufficient grant; obtaining it has unknown duration/outcome.       | Rights-holder scope and exact written grant. Explicit authority before any outreach.                                                                                                    |
| Project-side GPL linking exception/additional permission | Potentially retains DataScript and permits the particular combination while DataScript stays EPL. It does not relicense DataScript or erase its terms. It changes the effective project grant from unqualified GPL to GPL plus that permission. | S–M for reviewed notices/metadata and package audit; rights/provenance review is separate. | Confirm who may grant the exception for PDB's code, required consent, exact scope/text and how downstream modifications are handled. Owner selects this path only after that review.    |
| Replace the dependency with a compatible implementation  | Avoids relying on a DataScript-specific exception, but requires a new runtime/build adapter and semantic parity for native and project rules.                                                                                                   | L–XL migration, preceded by an S feasibility spike.                                        | Verify a candidate's exact license and actual Node/package support, then query/negation/aggregate/worker/budget parity and performance. Do not choose a replacement from license alone. |
| Retain current licensing while a path is unresolved      | Makes no claim that GPL migration is complete; preserves existing notices/releases while research/rights work continues.                                                                                                                        | No runtime migration.                                                                      | This is an interim hold, not reversal of the owner's GPL decision or a legal opinion on every past distribution.                                                                        |

The [GNU GPL FAQ on incompatible libraries](https://www.gnu.org/licenses/gpl-faq.html#GPLIncompatibleLibs)
describes a GPLv3 section-7 additional permission route and the copyright-holder
consent boundary. A project owner or current GitHub assignee is not, by itself,
proof of ownership of every contribution. The repo's sole-developer routing file
therefore cannot substitute for provenance review, particularly for extracted or
inherited code. An exception can only be authorized for rights its grantors hold.

## Concrete replacement candidate, not a drop-in recommendation

[Soufflé](https://souffle-lang.github.io/program) is a Datalog implementation with
an explicitly documented C++ interface and native functors. Its
[license at checked HEAD `2adf8c0`](https://github.com/souffle-lang/souffle/blob/2adf8c07210fe54f235e6e2d343c49b9d131463d/LICENSE)
is UPL-1.0; the [FSF UPL entry](https://www.gnu.org/licenses/license-list.html#UPL)
classifies that license as GPL-compatible. This supplies a concrete permissively
licensed research candidate, **not proof that its complete build/dependency
closure or a particular binary is cleared for PDB**.

Its native/C++ integration differs from the current npm DataScript runtime and
EDN query/rule interface. No Node adapter, WASM portability, packed install or
semantic/performance trial was performed here. Investigating one would need to
cover recursion, negation, aggregates, entity/value encoding, project-rule
sandbox/worker limits, output ordering and all existing native scenarios. A
newly written TypeScript evaluator would likewise be an engine project, not a
quick license edit. Keeping the native rules as the definitive policy source is
required under either replacement strategy.

## Recommended next step and small follow-ups

First undertake a bounded **rights/provenance and exception-feasibility review**.
That is the smallest technical path to determine whether we can retain a working
engine while meeting the owner's GPL objective. It is not a recommendation to
publish an unreviewed exception. Do not start an engine rewrite by default.

Proposed follow-ups after review of this report:

1. **Rights/provenance review** (S technical inventory, external review/consent
   unestimated): enumerate inherited project grants/holders, whether an adequate
   PDB-side exception can be granted, and any consent still needed. Output a
   reviewed go/no-go on that route; no license or upstream changes.
2. **Chosen license/notice implementation** (S–M, blocked by a reviewed rights
   decision): coherent LICENSE/package/README/contributor metadata and third-party
   notice audit, with package read-back. Preserve historical grants and do not
   retroactively relabel released MIT archives. Exception text, if chosen, must
   be accurate and reflected in valid metadata rather than an invented SPDX ID.
3. **Alternative-engine feasibility spike** (S, only if the owner chooses that
   route): test one compatible candidate's language and packaged runtime boundary
   before separately estimating migration. No unrelated policy changes.
4. **Upstream outreach** is optional, not performed or authorized by this report.
   Any request must specify the grant needed and who may authorize it; no
   unanswered request is evidence of permission.

The exact owner decision remains **which reviewed path to pursue**, not whether
the project should use GPL-3.0-or-later. Until permission/exception/replacement is
actually established, #634 stays blocked. Completion of #787 means the requested
comparison exists, not that distribution clearance or the GPL migration is done.

## Reproduction and limits

Compare the pinned upstream LICENSE bytes to `third-party/datascript-LICENSE`,
inspect the manifest/lock, runtime imports and package allowlist, then recheck the
linked primary license guidance. This is a local/manual source-and-provenance
review, not a CI test or a benchmark. Raw fetched pages stay outside the repo;
only the concise report and source links are committed. No private account data,
external messages, live license mutation, dependency migration or release was used.
