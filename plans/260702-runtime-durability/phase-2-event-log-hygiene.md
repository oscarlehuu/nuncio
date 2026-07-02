# Phase 2 — Event-Log Hygiene

**Status:** Planned · **Depends on:** nothing (parallel with Phase 1)

## Scope

- **Tail-first replay:** `GET :id/events` gains `limit` (max rows returned, newest-anchored when combined with `tail=true`) alongside the existing `since`. Contract stays on the `seq` cursor so 260701 Phase B's `subscribe(sessionId, since)` adopts it unchanged.
  - Repository: replace the unbounded `WHERE seq > ?` list in [events.repository.ts](../../apps/server/src/sessions/persistence/events.repository.ts) with a bounded variant; full replay remains available by paging.
- **Web adoption:** initial transcript load fetches the tail (session detail: last N blocks, then background-fill or scroll-up paging; grid LOD tiles: tail only — they already keep a ~30-block ring buffer). `use-session-stream` keeps its dedupe/sort logic.
- **Payload cap on append:** oversized event payloads (giant tool outputs) are truncated at write time with an explicit `truncated: true` marker in the payload, so the log can't grow unboundedly from one command's stdout.

## Out of scope

- Compaction/retention of archived sessions (revisit when disk or query time actually hurts).
- Snapshotting transcript state — the `seq` log stays the single source of truth.

## Verify

- Server specs: `limit`/`tail` semantics, cap-and-mark on oversized payload, paging returns the exact same sequence as one unbounded read.
- Web: session with a few thousand events opens fast (tail), scroll-up backfills without gaps or duplicate `seq`.
