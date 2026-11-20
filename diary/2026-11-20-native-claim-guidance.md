# #1115 the last TypeScript claim-obligation catalog

#1113 and #1114 had already moved the obligation records, their applicability and their order into
`policy/obligations.edn`, and the claim selector was already reading them through the native query.
What survived was the original authored list in `action-reminders.ts` and the `obligationsHash` that
was still computed from it, so the receipt's policy identity described a catalog the output no
longer used. Deleting the list was the easy part.

The hash needed a replacement rather than a deletion: it is the receipt's statement of which
obligations the caller was shown, so it has to change when an authored record changes. It now hashes
the compiled `obligations` records plus the selector source, and the new test proves both directions
— rewording a purpose or widening the early-publication work restriction changes the digest, while
an untouched clone keeps it. That test is the one thing the old catalog could still claim and the
native records now have to earn.
