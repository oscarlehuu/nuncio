# Reliability & Performance Foundation

**Status:** Complete — implementation, review, `gate`, and `gate:full` green
**Branch/worktree:** `feat/reliability-performance-foundation` in `/Users/a1241968/Desktop/Oscar/nuncio-reliability-performance-foundation`
**Goal:** reduce reconnect/socket fan-out and stop observability from deserializing every session event while preserving ADR-007 replay and current metric/timeline outputs.

## Locked scope and decisions

- Provider-neutral; keep one Bun daemon + SQLite (ADR-006/010), no Redis/microservice work.
- Server relay already multiplexes `subscriptions: Map<sessionId,…>` per socket; preserve the frozen v1 envelope. No server protocol change.
- Add an explicit core relay pool and use it for browser session streams. Keep the legacy standalone client for React Native's custom auth/recovery callbacks; mobile currently has one active transcript, so centralizing its manager is deferred.
- Pool key is the complete relay URL (direct or `/m/<machine>/…`): one physical socket per complete URL, with distinct hub-machine URLs using distinct sockets.
- Smallest safe observability slice: no rollup table. Timeline/digest reads use `[from,to)` and only timeline/metric event types; summary/session/rollups preserve existing outputs by loading only relevant event types (including lifetime `status` rows for current duration semantics), never assistant/tool/delta payloads.
- Preserve Crew boundary: only IDs from `listUserFacing(true)` may be queried. Keep small indexed per-session projections in this tranche; batch only if session-count measurements show query count is the next bottleneck.

## Phase 1 — Shared browser relay connection (TDD)

1. RED in `packages/core/src/session-relay-pool.spec.ts`: same URL/two sessions creates one socket; routes channels independently; keeps monotonic cursors; `behind` resubscribes only that channel; one drop reconnects once and resubscribes both cursors; RPC IDs correlate globally; closing one sends `unsubscribe` without killing the other; final close disposes/evicts; different URLs create two sockets.
2. GREEN add `packages/core/src/session-relay-pool.ts` plus `session-relay-shared-connection.ts`, and route plain browser subscriptions through it from `session-relay-client.ts`. The pool owns socket/reconnect/RPC state; each subscription owns cursor, tail, callbacks, resync/confirm/call/close. Keep the standalone client path for mobile compatibility.
3. RED in `apps/web/src/lib/use-session-stream.spec.tsx`: two hooks on one base share one socket and receive only their channel; unmount/session switch leaves siblings live; hub bases isolate sockets; visibility resync and reconnect remain gap-free.
4. GREEN update `apps/web/src/lib/use-session-stream.ts` to use one module-owned pool. Do not change REST bootstrap, tail paging, animation-frame batching, or seq dedupe.

## Phase 2 — Bounded observability event reads (TDD)

1. RED in `apps/server/test/unit/sessions/events.repository.spec.ts`: repository projections retain lifetime status for duration, window all other observability facts, strictly window timeline facts, and exclude transcript/tool noise and boundaries.
2. GREEN update `apps/server/src/sessions/persistence/events.repository.ts`; add the partial `idx_events_observability_window` idempotently in `apps/server/src/db/database.service.ts`. Use positional `?` params only.
3. RED in `apps/server/test/unit/observability/observability-crew-session-boundary.spec.ts` plus a new service-loading case in `observability.controller.spec.ts` or a focused `observability.service.spec.ts`: timeline passes effective `to = min(to,before)` and timeline-only types; summary/rollups never call `events.list(id)`; Crew member IDs and noisy delta/tool rows are not loaded; fold outputs remain byte-equivalent to current fixtures.
4. GREEN update `apps/server/src/observability/observability.service.ts`: build `eventsBySession` from the batched query; use timeline window before loading; keep pure folds unchanged unless a test proves an existing semantic bug.
5. RED/GREEN update `apps/server/src/attention/heartbeat/heartbeat.service.ts` and its existing digest specs so digest enrichment queries only its durable window and required event types. Do not alter digest counts/highlights/project lines.

## Verification and performance proof

- Red commands first, then green: `bun run --filter @nuncio/core test -- session-relay-pool`; `bun run --filter @nuncio/web test -- use-session-stream`; from `apps/server`: `bun test test/unit/sessions/events.repository.spec.ts test/unit/observability/`.
- Run `bun run --filter @nuncio/core check`, web test/build/lint, server unit/e2e, then `bun run gate` and `bun run gate:full` (includes real-browser Mock smoke).
- Add deterministic regression fixtures with many noisy events and assert returned rows/query calls are bounded; record before/after physical socket count for a 3×2 same-machine grid and loaded observability event-row count for the same seeded DB.
- Success: one relay socket per active complete browser relay URL; independent cursors survive reconnect; no event gaps/duplicate side effects; observability hot paths never N+1-load full transcripts; timeline/digest session-event row volume is window/type bounded; API shapes and existing metric/timeline values stay unchanged; all gates green.
- Final proof: core 362/362, web 886/886, server unit 2,337/2,337, server e2e 39/39, scripts 127/127, and 15/15 hermetic Chrome smoke checks. SQLite `EXPLAIN QUERY PLAN` selects `idx_events_observability_window` for the bounded fact query.

## Docs, release, risks

- Update `README.md`, `docs/ws-relay-contract.md`, and `docs/system-architecture.md` with connection ownership, pooling key, query/index strategy, and measured proof.
- User-visible reliability/performance change: add a **patch** changeset, e.g. “Improved multi-session streaming and timeline responsiveness by sharing relay connections and bounding event reads.”
- Risks: shared-socket failure has wider blast radius (mitigated by per-channel cursors/replay); close/resync races (generation checks + stale-socket rejection); SQLite variable limits (chunk IDs); timestamp ties (`[from,to)`, existing tie-page rule); hidden duration drift (golden equivalence tests; no duration refactor in this tranche).

## Unresolved questions

- None. Incremental rollup tables, mobile multi-session pooling, concurrency budgets, UI virtualization, and daemon safe mode remain later measured tranches.
