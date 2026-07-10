# Streaming No-Loss Hardening

**Status:** Complete
**Priority:** P0 durability
**Goal:** prevent transcript/event loss and frozen clients across shutdown, reconnect, provider disposal, and WS proxy failure while keeping WS v1 additive.

## Context and constraints

- North stars: [`README.md`](../../README.md), [`docs/product-vision.md`](../../docs/product-vision.md), [`docs/architecture-decisions.md`](../../docs/architecture-decisions.md), [`docs/testing-and-verification.md`](../../docs/testing-and-verification.md), [`docs/ws-relay-contract.md`](../../docs/ws-relay-contract.md).
- TDD only: add each regression, run it red for the intended assertion, implement minimum green, refactor, then run gates.
- Preserve append-only `seq` replay and frozen WS v1 envelopes; liveness limits/notices stay additive.
- Exclude queue semantics and long-history pagination unless a failing in-scope regression proves they are required.

## Phase 1 — Cancel verification and fence provider runs

- [x] Red: extend `apps/server/test/unit/sessions/session-verifier.spec.ts` and `sessions.verify-feedback-restart.spec.ts` for module-close cancellation: verifier shell/children stop, no post-close event/DB write, shutdown remains bounded.
- [x] Green: add `AbortSignal` cancellation/process-group termination in `apps/server/src/sessions/session-verifier.ts`; own per-session verifier controllers in `apps/server/src/sessions/sessions.service.ts` and abort them before drain.
- [x] Red: extend `apps/server/test/unit/agents/base-agent.provider.coalesce.spec.ts`, `base-agent.provider.stream-tail.spec.ts`, `pi-agent.provider.spec.ts`, and `apps/server/test/unit/sessions/sessions.service.spec.ts` for stale run callbacks, dispose-before-tail-flush, direct mid-run steer shutdown, and hung interrupt.
- [x] Green: update `apps/server/src/agents/agents.types.ts`, `agents.base-provider.ts`, `providers/pi-agent.provider.ts`, and `sessions/sessions.service.ts`: provider-neutral per-session run generations; one flush→invalidate→provider-dispose lifecycle; Pi abort then unsubscribe; track direct-steer promises; arm force-idle timeout before awaiting interrupt.
- [x] Delta durability: keep the base delta buffer until `EventsRepository.append` succeeds; a failed timer/synchronous flush must remain retryable and emit exactly once after recovery.

## Phase 2 — Make client bootstrap/recovery race-safe

- [x] Red web cases in `apps/web/src/lib/use-session-stream.spec.tsx`: session A refetch cannot replace B; failed initial REST bootstrap still opens WS from seq 0; visibility recovery remains gap-free.
- [x] Green web in `apps/web/src/lib/use-session-stream.ts`: request/session generation guard, bootstrap `finally` connection, and stale-result suppression without weakening seq dedupe.
- [x] Red mobile cases in new `apps/mobile/src/lib/use-session-transcript.spec.ts` plus `connection-manager.spec.ts`: failed REST bootstrap still starts manager/WS; foreground while connected resubscribes; `server_shutdown` freeze expires and probes again even without another OS signal.
- [x] Green mobile in `apps/mobile/src/lib/use-session-transcript.ts` and `connection-manager.ts`: start relay from seq 0 on bootstrap error, explicit connected foreground resync, bounded shutdown cooldown with disposed/stale timer guards.
- [x] Shared core changes were not required; `packages/core/src/session-relay-client.ts` remains wire-compatible and its existing suite stays green.

## Phase 3 — Bound direct and hub WS failure modes

- [x] Red direct-relay cases in `apps/server/test/unit/sessions/sessions.ws.spec.ts`: missed pong terminates socket/subscriptions; pong restores liveness; heartbeat timers clean up once.
- [x] Green direct relay in `apps/server/src/sessions/api/sessions.ws.ts`: ping/pong watchdog with injectable intervals/test seams and idempotent teardown.
- [x] Red hub cases in new `apps/server/test/unit/hub/hub.ws-proxy.spec.ts`: connect timeout closes both sides; pre-open queue and post-open `bufferedAmount` overflow close instead of growing; downstream/upstream missed-pong closes the pair; timers/buffers release on every terminal path.
- [x] Green hub in `apps/server/src/hub/hub.ws-proxy.ts`: explicit byte caps, connection deadline, bidirectional liveness, ready-state-safe forwarding, and one idempotent close path.

## Phase 4 — Integration, docs, release

- [x] Run focused red/green specs from `apps/server`, `apps/web`, and `apps/mobile` using their package scripts; record assertion-based red proof before production edits.
- [x] Run `bun run gate`, then `bun run gate:full`; perform the real-browser Mock-provider stream/steer/archive smoke. Live Pi was not invoked because it is outside the hermetic gate.
- [x] Run code-review pass after green; fix every confirmed P2/P3 finding without reversing verified ADR-007 behavior.
- [x] Update `README.md`, `docs/testing-and-verification.md`, `docs/ws-relay-contract.md`, and `docs/system-architecture.md` with cancellation/liveness guarantees and additive behavior; no roadmap milestone changed.
- [x] Add a patch changeset: `bun run add-changeset patch "Fixed streamed session output loss and frozen reconnects during shutdown and network failures."`; run `bun run check-changeset`.

## Acceptance criteria

- Every accepted provider callback belongs to the current run generation; dispose/shutdown cannot append stale deltas, and every accepted delta is persisted once or retained for retry.
- Module close cancels verifier and provider/direct-steer work within bounded time; no subprocess, timer, listener, buffered delta, or DB write survives teardown.
- Web/mobile always establish cursor replay after REST bootstrap failure; stale fetches never cross sessions; foreground and shutdown-cooldown recovery resume from highest seen `seq` without gaps/duplicates.
- Direct and hub sockets detect half-open peers and enforce finite connect/pre-open/outbound buffering limits; cleanup is idempotent.
- WS v1 clients remain compatible; focused suites, `gate`, `gate:full`, review, docs, and changeset are green.

## Unresolved questions

None.
