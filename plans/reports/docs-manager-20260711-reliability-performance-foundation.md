# Reliability & Performance Foundation — Docs Sync Audit

**Date:** 2026-07-11
**Docs impact:** minor — accuracy wording only; no architecture or scope change.

## Files checked

- `README.md`
- `docs/ws-relay-contract.md`
- `docs/system-architecture.md`
- `.changeset/improved-multi-session-streaming-and-timeline-re.md`
- `plans/260711-reliability-performance-foundation/plan.md`
- `packages/core/src/session-relay-client.ts`
- `packages/core/src/session-relay-pool.ts`
- `packages/core/src/session-relay-shared-connection.ts`
- `apps/server/src/db/database.service.ts`
- `apps/server/src/sessions/persistence/events.repository.ts`
- `apps/server/src/observability/observability.service.ts`
- `apps/server/src/attention/heartbeat/heartbeat.service.ts`

## Result

- Corrected shorthand from one browser connection "per machine" to "per complete relay URL" in README, changeset, and plan. This matches the pool's exact `Map` key and preserves isolation between distinct direct or `/m/<machine>/` URLs.
- Verified injected/custom-option clients retain the standalone connection path; plain browser clients alone use the shared pool.
- Clarified that logical consumers keep independent monotonic cursors and closed-handle behavior, while same-session consumers share one server channel from their minimum cursor and unsubscribe it only after the final consumer closes.
- Verified the partial SQLite index predicate matches repository projections. Observability reads lifetime `status` history plus `[from,to)` turn/steer/verify/attention facts; timeline reads only windowed `status` and `verify_needs_attention`; transcript/tool payloads are excluded.
- Verified public observability and digest sources remain scoped to `listUserFacing(true)`.
- Scoped the observability wording specifically to indexed session-event projections; tasks, loop runs, attention, and digest rows remain separate fold inputs.
- No unsupported benchmark or latency claim remains. Gate/test counts in the plan match the independent tester report.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Docs now match complete-URL pooling and bounded observability semantics exactly.
**Concerns/Blockers:** None.
