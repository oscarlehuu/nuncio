# Runtime Durability — Restart-Safe Daemon + Event-Log Hygiene

**Status:** Shipped (2026-07-02, both phases; TDD)

**Outcome notes:** pending-approval persistence + boot expiry already existed (`resolveStaleProviderRequests`, reason `server_restarted`) — Phase 1 shipped only the session sweep + Pi steer-after-restart proof. Phase 2 additionally fixed an O(n²) hot path found during implementation: the service re-read the full event list on every live agent event; providers now emit the appended event (seq included) and the service fans it out directly.
**Thesis:** Nuncio is only trustworthy enough to dogfood ("dùng nuncio build nuncio") if a daemon restart loses nothing and long transcripts stay cheap. This plan covers the two durability gaps that `260701-desktop-daemon-mobile` Phase B (WS relay) does *not* cover: what happens to running sessions and pending approvals when the daemon dies, and how the event log behaves as transcripts grow.

## Decisions (locked — founder, 2026-07-02)

| Decision | Choice | Why |
|----------|--------|-----|
| Transport | **Not touched here** — WS relay is [260701 Phase B](../260701-desktop-daemon-mobile/phase-b-daemon-relay.md), execute as designed | Phase B already specifies `subscribe(sessionId, since)`, backpressure, token auth. This plan keeps all semantics on the `seq` cursor so Phase B consumes them unchanged. |
| Provider priority | **Pi first** | Founder goal: Pi stability, then dogfood nuncio to build the rest. No new providers. Codex/Cursor get the same reconciliation sweep, but only Pi's resume path is a gate. |
| Pending approvals on restart | **Expire, don't restore** | An approval belongs to a provider process that died with the daemon (Codex stdio child is gone). Honoring it later would act on stale context. Expire + append an event so the UI unblocks. |
| Event `seq` allocation | **Keep `MAX(seq)+1`, no locking** | Single daemon process, synchronous `bun:sqlite` writes — verified single-writer at [events.repository.ts:30](../../apps/server/src/sessions/persistence/events.repository.ts). Revisit only if multi-process writers ever appear. |

## What already exists (do not rebuild)

- Persisted provider runtime state per session: `provider_thread_id`, `provider_active_turn_id`, `provider_state_json` ([sessions.repository.ts:259](../../apps/server/src/sessions/persistence/sessions.repository.ts)).
- Pi resume from its persisted session file: `pi.SessionManager.open(persistedFile, …)` rebuilds a handle lazily ([pi-agent.provider.ts:225](../../apps/server/src/agents/providers/pi-agent.provider.ts)); the session file is tracked as `providerThreadId`. Restart durability for Pi is mostly *wiring*, not new machinery.
- `provider_requests` table in SQLite (request lifecycle columns) — but live pending approvals sit in an in-memory map ([sessions.service.ts:52](../../apps/server/src/sessions/sessions.service.ts)).
- Append-only event log with monotonic `seq`, replay via `GET :id/events?since=` + SSE `GET :id/stream?since=`.
- Session FSM statuses drive UI borders (grid) and lifecycle guards.

## Gaps this plan closes

1. Daemon restart mid-run leaves sessions stuck in `RUNNING` with a set `provider_active_turn_id` — ghost "running" tiles, no error surfaced.
2. Pending provider approvals vanish silently on restart (map is in-memory; DB rows never rehydrated or expired).
3. Event replay has no `limit` — `GET :id/events?since=0` loads the whole transcript; grid LOD tiles only need a tail.
4. No cap on stored event payload size — one huge tool output bloats the log forever.

## Phases

| Phase | Focus | Plan |
|-------|-------|------|
| 1 | Restart reconciliation: boot sweep, approval expiry, Pi steer-after-restart proven by test | [phase-1-restart-reconciliation.md](./phase-1-restart-reconciliation.md) |
| 2 | Event-log hygiene: tail-first replay with `limit`, payload cap | [phase-2-event-log-hygiene.md](./phase-2-event-log-hygiene.md) |

Ordering rule: Phase 1 is the trust unlock (kill the daemon mid-run, restart, keep working). Phase 2 is independent and can land in parallel; it also feeds the grid's LOD tiles and Phase B's resubscribe path.

## Verify

- `bun test` in `apps/server` (new integration spec: kill/re-instantiate service mid-run → reconcile → steer continues).
- Manual: start a long Pi run, `kill` the daemon, restart, steer from the web UI — transcript continues, no gap, no duplicate events, no ghost RUNNING.
