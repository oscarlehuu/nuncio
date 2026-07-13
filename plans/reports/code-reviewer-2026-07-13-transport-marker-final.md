# Code review: transport duplicate marker final follow-up

Date: 2026-07-13
Scope: canonical-seq lookup, `transportDuplicateOfSeq` projection, shared parser, tests/docs

## Findings

No actionable findings. Both prior P2 findings are closed.

## Validation

- **CONFIRMED — out-of-window duplicate closed:** the repository returns an exact earlier canonical
  `user_message`/`steer_message` seq scoped to the same session
  (`apps/server/src/sessions/persistence/events.repository.ts:77-90`). The service decodes only a
  proven Nuncio transport form and attaches that canonical seq without mutating SQLite
  (`apps/server/src/sessions/sessions.service.ts:247-275`). The client no longer needs the canonical
  row inside its loaded window to suppress the duplicate.
- **CONFIRMED — empty-page cursor closed:** projected duplicates remain in the returned event array
  with their original seq, so `tail`, `before`, `limit`, relay high-water, and web `hasEarlier`
  retain a usable cursor. The all-duplicate-page regression pins this behavior
  (`apps/server/test/unit/sessions/sessions.live-watch-dedup.spec.ts:242-265`).
- **CONFIRMED — parser marker validation:** shared core skips a marker only when it is a positive,
  safe integer strictly lower than the current event seq
  (`packages/core/src/transcript-build-blocks.ts:394-409`). Invalid, forward, non-integer, and
  non-numeric values therefore remain ordinary input. The valid marker returns before assistant or
  thinking flush, preserving the completed response's order.
- **CONFIRMED — pagination + incremental semantics:** a marker-only initial tail renders no duplicate
  but keeps its seq. Loading the earlier canonical page changes the cached prefix, forcing the
  incremental builder's existing reset path; replay then renders one canonical user bubble followed
  by the assistant response (`apps/web/src/lib/use-transcript-blocks.ts:65-98`). Direct incremental
  replay of marker tail then prepended canonical page matched this result.
- **CONFIRMED — lone imported turn:** without an earlier canonical seq, the service returns decoded
  text without a marker, so the genuine user turn remains visible
  (`apps/server/src/sessions/sessions.service.ts:264-273`; regression at
  `apps/server/test/unit/sessions/sessions.live-watch-dedup.spec.ts:267-285`).
- **CONFIRMED — security:** the durable lookup uses bound SQL parameters, same-session scope,
  earlier-only ordering, exact decoded text, and canonical event types. The marker is generated at
  the server projection boundary from that lookup; no SQL injection, cross-session reference, or
  forward-reference hiding path found.
- **CONFIRMED — performance:** normal events do not query. Only exact transport-decodable legacy
  candidates perform the indexed same-session/earlier-seq lookup; this is proportionate to the rare
  compatibility path. No performance blocker found.
- **CONFIRMED — tests:** server live-watch/window specs passed 7/7; server window/repository specs
  passed 17/17; shared transcript specs passed 52/52; web incremental specs passed 14/14.
- **CONFIRMED — docs:** `docs/system-architecture.md:1548-1561` accurately records append-only
  storage, canonical-seq tagging, bounded-tail cursor preservation, shared suppression, and lone-turn
  sanitization. README scope remains appropriate.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Both prior P2s are closed. Canonical-seq markers suppress legacy transport duplicates across bounded windows while preserving paging and relay cursors; batch and incremental projections remain correct.
**Concerns/Blockers:** None.
