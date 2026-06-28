# Phase 04 — Transcript Hydration

**Priority:** P2 (UX — users want to see old context, not just the new steer)
**Status:** Not started
**Depends on:** Phase 2 (session row exists with `cursor_chat_id`)
**Estimated:** 1 day
**Lane:** A (backend) + small web touch

## Context Links

- [Plan overview](./plan.md)
- [Phase 1](./phase-01-list-local-sessions.md) — `cursor-transcript.parser.ts` is reused
- Event log: `apps/server/src/sessions/persistence/events.repository.ts`

## Overview

When a user opens an imported handoff session on the phone, they should see the **old conversation** from Cursor before they send a new steer. This phase reads the transcript JSONL and appends block-level events to the session's event log so the existing `Transcript` component renders them. No fake token streaming — block-level is enough.

## Key insights

- Reuse `cursor-transcript.parser.ts` from Phase 1 (pure JSONL → structured turns).
- Emit **block-level** events, not token deltas: `user_message { text }`, `assistant_message { text }`, `tool_start` / `tool_end` (if the turn had tool uses).
- Hydration is **once**: on first open of an imported session, if the event log is empty (or has fewer events than the transcript), backfill. Use a session-level flag or compare counts.
- Order: hydrated old events get `seq` 1..N; the first steer (Phase 3) appends from N+1.
- Subagent JSONL files (in `subagents/`) are out of scope — only the main `<chatId>.jsonl`.

## Requirements

### Functional
- `SessionsService.hydrateTranscript(sessionId)`:
  - Reads `~/.cursor/projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl`
  - Parses via `cursor-transcript.parser.ts`
  - Maps turns → events; appends to `events` table with sequential `seq`
  - Idempotent: if already hydrated (flag or count match), no-op
- Triggered lazily on `GET /api/sessions/:id` (or `GET /api/sessions/:id/events`) when session has `cursor_backend='cli'` and event log is empty.
- `user_message` text stripped of `<user_query>` / skill wrappers before storing.
- Assistant turns with tool uses: emit `tool_start` + `tool_end` around the `assistant_message` for parity with SDK sessions.

### Non-functional
- One-shot read + bulk insert in a single transaction.
- Must not block if transcript is missing (deleted by Cursor) — log + return empty.
- Cap hydration at ~500 turns to avoid pathological transcripts.

## Architecture

```
SessionsService.getOrHydrate(sessionId)
  1. Load session row; if cursor_backend !== 'cli' → return as-is
  2. Count events for session; if > 0 → already hydrated (or hydration attempted) → return
  3. CursorLocalSessionsService.readTranscript(chatId, workspace) → parsed turns
  4. Map turns → events[] (block-level)
  5. EventsRepository.appendBatch(sessionId, events) — single transaction
  6. Return session + events
```

New repo method: `EventsRepository.appendBatch(sessionId, events[])` — bulk insert with seq assigned in one transaction (reuses the existing seq logic).

## Related code files

**Modify:**
- `apps/server/src/sessions/sessions.service.ts` — `getOrHydrate()` + call from `findOne()` / `listEvents()`
- `apps/server/src/sessions/persistence/events.repository.ts` — `appendBatch()`
- `apps/server/src/cursor-local/cursor-local-sessions.service.ts` — `readTranscript(chatId, workspace)` returning parsed turns (reuses Phase 1 parser)

**Create:**
- `apps/server/test/unit/sessions/sessions.hydrate.spec.ts`

**Delete:** none.

## Implementation steps

1. TDD `sessions.hydrate.spec.ts`:
   - Session `cursor_backend='cli'`, empty event log, fixture transcript with 4 turns → after hydrate, 4+ events in order
   - Second hydrate call → no-op (idempotent)
   - Transcript missing → no error, empty events
   - SDK session (`cursor_backend='sdk'`) → hydrate skipped
   - `<user_query>` wrapper stripped from `user_message`
2. Implement `EventsRepository.appendBatch()` (single transaction, seq assignment).
3. Implement `CursorLocalSessionsService.readTranscript()` (full parse, not just first/last line).
4. Implement `SessionsService.getOrHydrate()` and wire into `findOne()` + `listEvents()`.
5. Add turn → event mapping helper (pure, unit-tested alongside the service spec).
6. `bun run test` + `bun run lint` green.

## Todo

- [ ] TDD hydrate spec
- [ ] `EventsRepository.appendBatch()`
- [ ] `CursorLocalSessionsService.readTranscript()`
- [ ] `SessionsService.getOrHydrate()` + wiring
- [ ] Turn → event mapping (pure helper + tests)
- [ ] `<user_query>` / skill wrapper stripping
- [ ] `bun run test` + `bun run lint` green

## Success criteria

- Import a real chat (Phase 2) → `GET /api/sessions/:id/events` returns the old conversation as `user_message` / `assistant_message` events in order.
- Re-fetch is a no-op (event count stable).
- Transcript deleted from disk → no 500, empty events.
- Existing SDK sessions unaffected (hydrate skipped).

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Transcript very large (1000+ turns) | Cap at 500; truncate with a `assistant_message { text: "[…truncated…]" }` marker |
| Hydrate races with first steer | Hydrate runs before any steer can (steer requires IDLE + event log check); serialize via service-level mutex per session |
| Cursor deletes transcripts on cleanup | Missing file → empty events, session still usable for new steers |
| `seq` collision with concurrent append | `appendBatch` runs in a transaction; existing seq logic already atomic |

## Security considerations

- Transcript may contain code snippets / file contents the agent read — store as-is (it's the user's own data) but don't log full events at INFO level.
- Strip skill/context wrappers from `user_message` so the phone UI doesn't show internal scaffolding.

## Next steps

- Phase 5 wires the picker UI + import flow on the phone.
