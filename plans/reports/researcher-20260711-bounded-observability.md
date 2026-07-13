# Bounded observability event reads

## Recommendation

Ship one TDD-sized repository projection, not rollup tables: read only the six event types observability can consume, and time-bound every non-duration row in SQL. Reuse it from `ObservabilityService` and heartbeat digest generation. Keep folds and response DTOs unchanged.

This removes full transcript/history materialization from timeline, summary, rollups, per-session metrics, and scheduled digests while preserving current semantics.

## Current evidence

- `ObservabilityService.sources()` loads every event for every user-facing session with `events.list(session.id)` before any `[from,to)` filter (`apps/server/src/observability/observability.service.ts:72-83`). `/api/timeline` defaults to last digest or 24 hours, but still performs that full load (`observability.service.ts:60-69,95-102`).
- Heartbeat repeats the same full-history/all-session load for each digest (`apps/server/src/attention/heartbeat/heartbeat.service.ts:269-300`).
- The active app/core client calls `/api/timeline`; MCP also calls timeline/session observability. No web caller currently consumes summary/rollups directly.
- Folds inspect only:
  - metrics: `user_message`, `steer_message`, `steer_queued`, `verify_result` (`observability-metrics.ts:84-108`);
  - duration: `status` (`observability-metrics.ts:110-129`);
  - timeline: `status`, `verify_needs_attention` (`observability-timeline.ts:80-108`).
- Existing event index is only `(session_id, seq)` (`database.service.ts:35-46`); it cannot seek a created-time window.

## Exact query design

Add two explicit `EventsRepository` projections. Keep fixed literals in SQL so SQLite can prove and use a partial index.

1. `listObservabilityWindow(sessionId, from, to)`:
   - all historical `status` rows (duration contract);
   - only `[from,to)` rows for `user_message`, `steer_message`, `steer_queued`, `verify_result`, `verify_needs_attention`;
   - combine two indexed queries, avoiding an `OR` scan; return sorted by `created_at, seq` or let existing duration fold sort.
2. `listTimelineWindow(sessionId, from, to)`:
   - only `[from,to)` `status` and `verify_needs_attention` rows.

Partial index:

```sql
CREATE INDEX IF NOT EXISTS idx_events_observability_window
ON events(session_id, type, created_at, seq)
WHERE type IN (
  'status', 'user_message', 'steer_message', 'steer_queued',
  'verify_result', 'verify_needs_attention'
);
```

Each query must repeat that exact fixed partial predicate, then add its narrower type predicate, e.g.:

```sql
SELECT id, session_id, seq, type, payload, created_at
FROM events
WHERE session_id = ?
  AND type IN ('status','user_message','steer_message','steer_queued','verify_result','verify_needs_attention')
  AND type IN ('status','verify_needs_attention')
  AND created_at >= ? AND created_at < ?;
```

Local Bun/SQLite `EXPLAIN QUERY PLAN` confirmed this form uses `SEARCH ... USING INDEX ... (session_id=? AND type=? AND created_at>? AND created_at<?)`. A parameter-only subset did not prove the partial predicate and degraded to `SCAN events`; do not hide the fixed predicate behind only `IN (?,?)`.

## Service wiring

- Parse the query window before building sources.
- `summary`, `rollups`, and heartbeat digest project rollups use `listObservabilityWindow`.
- `session(id,...)` loads events only for the matching user-facing session, not every session. Still exclude Crew member sessions.
- `timeline` uses `listTimelineWindow`; use `effectiveTo = min(window.to, before)` when `before` is finite because pagination is exclusive.
- Heartbeat passes its durable `[windowFrom,windowTo)` into its observability source builder instead of calling `events.list()`.
- Keep `tasks`, loop runs, attention, digest rows, fold functions, DTOs, timestamp tie expansion, and source filters unchanged in this patch.

## Semantic traps to lock with tests

1. **Duration is lifetime, not windowed.** `durationFromEvents` intentionally folds every historical status event even when event counts use `[from,to)`. Dropping pre-window `RUNNING`/terminal status changes totals and open `runningMs`. Therefore metrics/digest sources need all status rows; timeline does not.
2. **`before` is exclusive.** Event SQL upper bound may be reduced to `before`, but must remain `< before`. Timeline keeps all entries sharing the last returned timestamp, so never push `LIMIT` into per-session SQL.
3. **Crew boundary.** Only `sessions.listUserFacing(true)` sessions may feed public observability. Per-session optimization must not switch blindly to `findById`, which would expose/load internal `verify_owner='crew'` sessions.
4. **Day rollup semantics are unusual but sticky.** Events/duration group under the session's creation day, not each event's day (`observability-rollups.ts:42,55-68`). Do not SQL-group events by their own date in this patch.
5. **Bounds are inclusive-from/exclusive-to.** Preserve `created_at >= ? AND created_at < ?` exactly.
6. **Timeline source competition.** Do not SQL-limit events: session/task/loop/attention/digest facts compete in the final significance sort, and a timestamp group may exceed the requested page size.

## TDD changes

### Repository red tests

Extend `apps/server/test/unit/sessions/events.repository.spec.ts`:

- seed old/new relevant events plus a large `assistant_delta`/tool flood;
- `listObservabilityWindow` returns all status history, returns metric/timeline types only inside `[from,to)`, and never returns deltas/tools;
- `listTimelineWindow` returns only the two timeline types and honors exact boundaries;
- rows remain deterministic on equal timestamps via `seq`.

Extend `apps/server/test/unit/db/database.service.spec.ts`:

- assert `PRAGMA index_list(events)` contains `idx_events_observability_window`;
- optionally assert its columns via `PRAGMA index_info`; avoid timing assertions in CI.

### Service red tests

Add `apps/server/test/unit/observability/observability-bounded-sources.spec.ts`:

- spies make legacy `events.list()` throw;
- summary/rollups call the observability projection with the parsed exact window;
- timeline calls the strict projection with `to=min(to,before)`;
- `session(id)` loads only that user-facing session;
- output equals the current fold result for fixtures containing pre-window status, in-window metric events, irrelevant deltas, and boundary timestamps.

Update `observability-crew-session-boundary.spec.ts` to assert projection calls only for Solo/user-facing IDs.

Extend `apps/server/test/unit/attention/heartbeat/digest-session-source.spec.ts` (or nearest heartbeat source spec): legacy `events.list()` throws, bounded projection receives the digest window, and timeline/project rollup output remains identical.

Run from `apps/server`:

```bash
bun test test/unit/sessions/events.repository.spec.ts
bun test test/unit/observability/
bun test test/unit/attention/heartbeat/
```

Then repository root: `bun run gate`.

## Performance risks and follow-up

- The partial index avoids indexing noisy assistant/tool events, so write amplification is limited to the six low-volume fact types. A full `(session_id,created_at)` index would index every streaming delta and is not recommended.
- This keeps the existing per-session query shape (up to two small indexed reads/session). It removes dominant row/payload materialization but not N+1 query count. Only add a chunked batch API after measurement shows session count, rather than transcript volume, is the next bottleneck.
- All-time summary still returns all historical status + metric fact rows by contract (`from` defaults to `0`), but never assistant deltas/messages/tool payloads. A future aggregate table is justified only if these low-volume facts become material at measured scale.
- Other durable sources still load full task/loop/attention/digest lists. They are smaller and semantically cross-linked (loop settlement uses linked task `finishedAt`); bound them separately only with dedicated equivalence tests.

## Docs impact

No API/user behavior change, no changeset. README claims remain true. Add `<!-- no-changeset -->` to the PR body. Optional one-line architecture note: observability reads bounded durable fact projections, not transcripts. No roadmap/changelog update needed for this internal performance refactor.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Identified duplicate full-history loads in observability and heartbeat; proposed one partial-indexed event projection with strict windowing and lifetime-status preservation.
**Concerns/Blockers:** None. Do not window duration status history or push timeline limit into SQL.
