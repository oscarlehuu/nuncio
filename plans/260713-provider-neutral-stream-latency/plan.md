# Provider-neutral stream latency

Status: completed — `bun run gate:full` + independent review green
Priority: high
Target: `fix/faster-provider-neutral-streaming` -> `dev`

## Goal

Make the first durable model text visible immediately across every engine, keep later token bursts efficient, and open live relay bootstrap without waiting on REST.

## Invariants

- Shared `BaseAgentProvider` and transcript UI only; no provider-specific branch.
- Event-log append commits before WS/SSE fan-out; durable `seq` remains replay truth.
- First delta of each contiguous type/base segment persists and emits immediately.
- Later deltas in that segment coalesce for 100 ms or 2,000 characters.
- REST and WS bootstrap may race; merge by `seq`, sorted, duplicate-free, highest cursor never regresses.
- Session switch, dispose, replacement run, type/base change, and non-delta events reset segment-head state safely.

## Red tests

1. Web bubbles: streaming assistant and expanded thinking text render the complete received value immediately, without timers.
2. Session detail: a first `assistant_delta` is fully visible while status is `RUNNING`; terminal message remains exact.
3. Bootstrap: a deferred REST request still opens WS in a microtask and subscribes from `since: 0` with the requested tail.
4. Bootstrap race: WS seq 3/4 before late REST seq 1-3 yields exactly `[1,2,3,4]`, including when RAF holds the live event pending.
5. Bootstrap cursor: late REST cannot reconnect the socket or regress visibility resync below the highest live seq.
6. Base provider: first assistant/thinking segment delta is synchronously durable and emitted as the same committed row.
7. Base provider: rapid remainder becomes one coalesced tail; concatenated rows equal exact source text.
8. Failure: first append failure fans out nothing, retries once, preserves ordering, and never duplicates.
9. Boundaries: changed type/base, non-delta event, replacement run, oversized/multibyte delta, and dispose start a safe new head or preserve the tail.
10. Update provider conformance, stream-tail boundary, timer-retry, and Codex shutdown expectations for head-plus-tail semantics.

## Green implementation

1. Remove the artificial `useThrottledStreamText` reveal from assistant/thinking bubbles; keep frame batching in `useSessionStream`.
2. Start `subscribeSessionEvents` from a queued microtask as soon as the session effect installs; fetch REST concurrently.
3. Remove the 1-second bootstrap gate; merge late REST into current and RAF-pending live events by durable `seq` without replacing state.
4. Track the open delta segment in `BaseAgentProvider`; append/emit its head immediately through the existing durable path.
5. Buffer only subsequent matching deltas; retain the existing 100 ms, 2,000-char, retry, teardown, and generation fences.
6. Clear segment metadata only at logical boundaries, not after every tail flush.

## Edge cases

- REST fails or never settles; WS replay alone completes bootstrap.
- REST returns a duplicate of an RAF-pending live row.
- Visibility/resync fires before React state flush.
- SQLite fails on head or tail; retained events keep commit order and bounded memory.
- Thinking IDs change; tool/status/terminal events cannot be overtaken by buffered text.
- Session changes before queued microtask or REST completion; generation fence prevents stale connect/merge.

## Verification

1. Run focused server specs for base provider, provider contracts, and Codex shutdown.
2. Run focused web specs for bubbles, session detail, and `use-session-stream`.
3. Run web build/lint, server lint, then `bun run gate` and `bun run gate:full`.
4. Extend the existing Mock real-browser smoke to assert first text appears promptly and the final transcript is exact after reconnect.
5. Run `git diff --check` and `bun run check-changeset`.

## Delivery

- Update `README.md` streaming description and `docs/ws-relay-contract.md` bootstrap wording without changing WS v1.
- Add a patch changeset describing faster first streamed text with unchanged replay reliability.
- Code review after green tests; fix blockers before commit/PR.

## Dependencies

- ADR-003/004/007 and `docs/testing-and-verification.md` remain authoritative.
- No unresolved product decision; segment identity is `(event type, non-delta payload base)`.
