# Code review: server transport projection follow-up

Date: 2026-07-13
Scope: `EventsRepository.hasUserInputTextBefore`,
`SessionsService.projectPersistedTransportUserEvents`, new tests/docs

## Findings

### P2 — CONFIRMED: filtering after pagination can make older history unreachable

`getEvents` first selects the requested `tail`/`before`/`limit` window, then removes matching
transport duplicates (`apps/server/src/sessions/sessions.service.ts:228-245`). If every row in the
selected page is suppressed, the API returns `[]` even though canonical and other older events still
exist. The web computes `hasEarlier` only from the first returned event
(`apps/web/src/lib/use-session-stream.ts:220-222`), so an empty initial page reports no older history
and exposes no way to page back. The same issue can stall `loadEarlier`, because an empty backfill
leaves `oldestSeq` unchanged and the next request repeats the same `before` cursor
(`apps/web/src/lib/use-session-stream.ts:150-165`).

The new tail regression already demonstrates under-filling: requesting two rows returns one after
projection (`apps/server/test/unit/sessions/sessions.live-watch-dedup.spec.ts:213-236`). It does not
cover the fully filtered page. With the same fixture and `tail: 1`, the selected row is the polluted
duplicate, projection removes it, and the response is empty while the canonical seq remains earlier.

This does not reopen runtime-instruction exposure, but it is a user-visible pagination regression and
means the bounded-history contract is not yet complete.

## Validation

- **CONFIRMED — prior P2 closed:** the durable lookup is scoped by `session_id`, strictly earlier
  `seq`, canonical user families, and exact decoded text
  (`apps/server/src/sessions/persistence/events.repository.ts:77-89`). Therefore a polluted row is
  omitted even when its canonical match is outside the returned tail.
- **CONFIRMED — lone import preserved safely:** when no earlier canonical exists, the service returns
  a copied event with decoded text rather than deleting or mutating SQLite
  (`apps/server/src/sessions/sessions.service.ts:247-267`). The new lone-import test pins this
  (`apps/server/test/unit/sessions/sessions.live-watch-dedup.spec.ts:238-256`).
- **CONFIRMED — query security:** SQL inputs are bound parameters; type and sequence predicates keep
  matching session-local and earlier-only. No injection or cross-session match found.
- **CONFIRMED — performance acceptable for intended legacy path:** the durable lookup runs only for
  text that the exact transport decoder changes. Normal events incur no extra query. The existing
  `(session_id, seq)` index bounds each lookup to one session's earlier rows; no blocker found for the
  rare compatibility candidates.
- **CONFIRMED — focused verification:** `bun test
  test/unit/sessions/sessions.live-watch-dedup.spec.ts` passed 6 tests, 0 failures.
- **CONFIRMED — docs:** `docs/system-architecture.md:1548-1558` accurately describes durable-log
  lookup, lone-event sanitization, and append-only storage. It does not document the empty-page
  behavior above.

## Unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** The original bounded-window duplicate exposure is fixed, with correct exact durable lookup and safe lone-import sanitization. One confirmed P2 remains: post-pagination filtering can return an empty page and block access to older history.
**Concerns/Blockers:** Pagination must preserve a usable older-history cursor when projected rows are omitted.
