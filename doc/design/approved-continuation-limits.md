# Approved continuation: user budgets versus per-event safeguards

Implementation contract for #657. The owner explicitly rejected an arbitrary PDB
work/spending cap on ordinary approved continuation. This supersedes the default
three-offer budget and full-history stop as requirements in shared-rebrief-core.md,
packaged-native-hook.md and doc/rebrief.md. Those documents describe current v1
implementation until the focused runtime migration ships. No hook is activated or
trusted by this design, and no native stop cause is inferred from approval alone.

## Decision and retained boundaries

Normal installed/approved continuation has no default total-offer limit. A human
may explicitly select a finite limit, which is shown as a user budget rather than
an unavoidable platform constraint. Existing `--cap N` is an explicit finite
choice; extend the request/state model to represent no selected cap separately
from zero or unknown. Do not silently assign cap 3 when the value is absent in a
new normal session, or silently remove a known user-selected budget.

Native rules decide continuation eligibility, configured-budget exhaustion and
workflow reasons from normalized facts. Host mechanics retain actual native
provenance, user interruption/cancellation, request validation, exact
repo/host/human/agent/session binding, per-request deadlines, bounded stdin and
briefing output, private-state integrity, deduplication and protocol framing.
Unknown cause is not rewritten to natural completion. An explicit interruption
must abort an in-flight fetch and suppress its result; user approval does not
make a late result permission to resume a cancelled turn.

Duplicate event callbacks, reentry, unchanged acknowledged fingerprints and
ambiguous unacknowledged delivery still suppress a new offer. A failed transport,
state operation or unavailable native capability is reported honestly and allows
normal stop; no automatic model invocation or blind retry is introduced.
`continue` is still an offer, not proof of delivery or a ticket claim. Only exact
native event/fingerprint receipt may be acknowledged.

## Versioned state without a disguised total-work cap

The current v1 state validates offers <=3 and stores at most 128 events inside one
64 KiB file. Merely removing the offer comparison would leave another arbitrary
session-length stop. Introduce v2 with small metadata plus private digest-keyed
event/receipt records, under the same verified session directory and lock. Event
and fingerprint keys are cryptographic digests, never raw IDs, paths or text.

Metadata holds binding, schema version, optional explicitly selected budget,
counters for diagnostics and at most one pending offer. Each bounded record
holds only hashes, disposition and safe counters. A check reads the metadata,
its event key and candidate fingerprint key; it does not load an ever-growing
array or list the whole directory. Retain acknowledged records for the session
so replaying an older callback cannot become fresh after a rolling window.
Storage grows with actual events; it is not an arbitrary continuation allowance.
Disk/permission errors remain technical failures, not fabricated budget reasons.
Cleanup occurs only after that owned adapter/session ends, never by deleting
another session's state or breaking a lock by age.

Use existing private-file/lock/atomic-write boundaries. Reserve the exact pending
identity durably before returning an offer. Persist acknowledgement and indexes
under that lock; incomplete/crashed updates leave delivery uncertain, never a
new offer. A bounded per-operation recovery check reconciles the matching records
or returns a concrete state error; it must not clear a pending offer or claim a
receipt just to make progress. No transcript, briefing body, credentials or raw
native session/event value is stored.

## Legacy compatibility and initialization

V1 state remains readable under its documented restrictions. Do not reset its
counters, erase fingerprints, or reinterpret its cap as unlimited without an
explicit migration choice: v1 cannot reliably distinguish an old default from a
human-selected budget. Report the legacy mode and supported recovery, not a
silent upgrade or an implicit new session. A versioned migration, if implemented,
previews and preserves context, event/delivery records and pending uncertainty;
it needs explicit choice to retain a finite budget or adopt no total cap. Failed
migration leaves the original valid state recoverable and never creates two
usable sessions for one binding. Unknown future state is not overwritten.

New installed-mode bindings may initialize once on a verified session-start or
eligible event through a shared ensure-session service, using real native context.
This initializes identity/state, not a synthetic pre-known session or a work
budget. A concurrent winner is reused; resume must not reset an existing binding.
Missing directory after OS cleanup is not proof that an old still-active session
may be safely recreated: require the supported native start/binding evidence or
report unavailable. Trial-mode explicit init remains available and honest.

## Delivery slices and verification

1. V2 state/optional-budget model and crash-safe indexed receipts with injected
   filesystem/clock, preserving v1 read/refusal behavior.
2. Native continuation defaults and shared ensure-session integration; update
   CLI help and doc/rebrief.md to describe the shipped version and migration.
3. Platform adapters consume the same result; no native payload, trust store or
   client configuration is rewritten as a side effect of this core change.

Test more than three changed approved offers and more than 128 callbacks without
resetting dedup or inventing a cap. Also test explicit finite exhaustion, duplicate
and concurrent callbacks, reentry, unchanged/older fingerprints, pending/unknown
receipt, cancellation before/after I/O, wrong context, corrupt/future/v1 state,
interrupted migration and actual disk failures. Bound each record/request rather
than adding an expensive default soak or paid model trial. Preserve JSON stdout
and existing permission/evidence semantics.

#581/#582's manifest, identity, MCP and attended configuration work does not wait
for a broad native-cause survey or every platform adapter. This contract does not
claim that normal uncapped hook execution is available before its core and native
binding capabilities actually ship. Installer result fields must distinguish
configured, trusted, executed and verified, with exact partial/recovery guidance.
