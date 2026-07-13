# Reliability & Performance Foundation — Code Review

**Date:** 2026-07-11
**Scope:** frozen diff on `feat/reliability-performance-foundation`
**Result:** PASS after re-review — both shared-relay blockers were fixed and no blocking finding remains.

## Findings

### High — CONFIRMED — A higher-cursor consumer receives replay events below its own `since`

`packages/core/src/session-relay-shared-connection.ts:138-143` subscribes the physical channel from the minimum cursor across same-session consumers, which is necessary for the oldest consumer. But `packages/core/src/session-relay-shared-connection.ts:108-111` then forwards every replayed event to every consumer and advances every consumer cursor without checking that consumer's own `lastSeq`.

Example: consumer A joins `s1` at `since=2`, consumer B joins at `since=5`; the shared server subscription starts at 2, so replayed seq 3/4 are now delivered to B. Separate pre-change subscriptions would never deliver those rows to B. This can repeat already-processed side effects for any core caller that is not the web hook's seq-deduping reducer, and contradicts the plan's no-duplicate-side-effects success criterion.

The current fan-out test does not cover the boundary: `packages/core/src/session-relay-pool.spec.ts:119-131` sends only seq 6, above both cursors. Add a regression where seq 3/4 reach only the `since=2` consumer while seq 6 reaches both, then preserve a channel-level replay cursor without weakening each logical consumer's cursor contract.

### High — CONFIRMED — A closed logical handle can still issue mutating RPCs

The returned handle closures in `packages/core/src/session-relay-shared-connection.ts:54-60` retain the `Consumer` after `close()`. `removeConsumer()` deletes it from the channel map (`:221-233`) but never marks it closed. `call()` checks only the physical connection (`:205-218`), so `handle.close(); handle.call('steer', ...)` still sends and resolves whenever another channel keeps the pooled socket open. `resync()` and `confirmResync()` have the same missing logical-liveness guard; a closed handle can affect/reuse a sibling subscription.

This regresses the standalone client's post-close contract, where `call()` rejects and `resync()` is a no-op (`packages/core/src/session-relay-client.ts:263-290`, `:297-306`). Add per-consumer closed state and tests that post-close `call` rejects, `resync` is inert, and `confirmResync` returns false while a sibling channel remains healthy.

### Low — SPECULATIVE — One duplicate consumer callback can prevent sibling delivery

Same-session fan-out invokes callbacks serially with no fault boundary (`packages/core/src/session-relay-shared-connection.ts:108-111`). If one consumer callback throws, later consumers do not receive that event even though the new abstraction presents them as separate logical subscriptions. Current web callbacks are not expected to throw, so this is not a merge blocker by itself; a per-callback `try/catch` or an explicit callback-failure policy would limit the new shared failure domain.

## Verified areas with no finding

- SQL `[from,to)` boundaries and selected event types match the folds. Lifetime `status` rows preserve the existing duration calculation; transcript/tool rows are excluded.
- Manual `EXPLAIN QUERY PLAN` confirms all three new repository queries use `idx_events_observability_window`; multi-type queries additionally use a temporary B-tree only for final ordering.
- Timeline `to = min(to,before)` preserves the existing exclusive pagination boundary.
- Crew filtering remains anchored to `listUserFacing(true)`.
- The browser pool key is the complete relay URL, so hub machine paths remain isolated; the injected React Native transport stays standalone.
- README, relay-contract, architecture text, and patch changeset accurately describe the implementation overall. README's shorthand “bounded” is clarified by the architecture doc's lifetime-status exception.

## Test/lint assessment

The two changed-test lint warnings are **non-blocking**: `apps/web/src/lib/use-session-stream.spec.tsx:22` is a test-double `no-this-alias` warning, and `:70` is an unsafe-optional-chaining warning inside an assertion helper. Gates pass, neither affects production behavior. They are reasonable cleanup candidates but did not supersede the initial relay correctness findings.

At initial review, the gate evidence was strong but tests did not exercise per-consumer cursor filtering or operations after logical close, which is why both regressions passed. The final re-review below verifies the added coverage.

## Unresolved questions

None.

**Initial Status:** DONE_WITH_CONCERNS
**Initial Summary:** Observability/index work was correct; shared relay needed per-consumer cursor filtering and logical-handle closure guards before merge.
**Initial Concerns/Blockers:** Two confirmed high-severity relay regressions above.

## Final re-review

Both prior high-severity findings are **RESOLVED and verified by source + regression tests**:

- Per-consumer cursor isolation: `packages/core/src/session-relay-shared-connection.ts:111-115` now drops events at or below each consumer's own monotonic `lastSeq`, while the physical channel still requests the minimum cursor at `:138-147`. The regression at `packages/core/src/session-relay-pool.spec.ts:119-138` proves seq 3/4 reach only the `since=2` consumer and seq 6 reaches both. This preserves gap recovery without replay side effects on the higher-cursor consumer.
- Logical close semantics: each consumer now owns `closed` state (`packages/core/src/session-relay-shared-connection.ts:13`, `:43-49`); resync/confirmation guard it at `:55-62`, RPC rejects it at `:209-224`, and close marks it before removal at `:227-241`. Regressions at `packages/core/src/session-relay-pool.spec.ts:156-184` verify post-close resync is inert, confirmation is false, and a mutating RPC is not sent.

The fixes do not alter independent-channel reconnect, `behind` recovery, tail aggregation, pending-RPC ownership, mobile's standalone injected transport, or the observability SQL semantics previously reviewed. The remaining speculative callback fault-boundary note is non-blocking and unchanged; current production callbacks are not expected to throw.

Final verification evidence reported on the frozen fix: core 362/362, web 886/886, `gate` PASS, `gate:full` PASS. The two changed-test lint warnings remain non-blocking.

**Final Status:** DONE
**Final Summary:** Re-review complete; both confirmed blockers are fixed with focused regression coverage, and no blocking finding remains.
**Final Concerns/Blockers:** None.
