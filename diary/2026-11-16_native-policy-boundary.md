# Native workflow decision architecture (#679)

Audited representative current paths at abcee7c: PR status invents a universal verify requirement, review policy/admission/completion/rollback contain independent workflow judgments, and collection/normalization/execution need a sharper boundary. Added a documentation-first contract with explicit target facts, native decisions/witnesses, host mechanics and staged migrations.

Included the owner's explicit direction-over-defaults clarification and outage continuation/reconciliation without inventing facts or caller authority. Kept #675/#676 focused, #680 as the complete audit, and human-assignment activation subject to its current recorded prerequisites. No runtime policy or external project settings changed.

Final review incorporated #697 P6: retire the independent TypeScript PR findings with the rollback path. Corrected historical hold wording after the owner lifted #662 readiness hold.

Validation: `npm run check` passes with existing warnings; `npm run build` passes. The first full test run passed 2,401 tests (one skipped); the rerun on merged main a5f4203 (including the quota-page feature) passed 2,416 tests with one skipped. No root TODO.md exists in this checkout.
