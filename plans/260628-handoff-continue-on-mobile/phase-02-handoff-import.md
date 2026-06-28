# Phase 02 — Handoff Import + Schema Migration

**Priority:** P1
**Status:** Not started
**Depends on:** Phase 1 (service exists for `alreadyImported` wiring)
**Estimated:** 1 day
**Lane:** A (backend)

## Context Links

- [Plan overview](./plan.md)
- [Phase 1](./phase-01-list-local-sessions.md)
- Migration template: `apps/server/src/db/database.service.ts` → `migrate()` (`provider` column ALTER)

## Overview

User picks one chat from the Phase 1 picker and imports it. This phase adds the DB columns, the `POST /api/sessions/handoff` endpoint, and the `SessionsService.handoff()` method. **No CLI spawn yet** — the imported session lands in `IDLE` with transcript hydration deferred to Phase 4 and steer deferred to Phase 3.

## Key insights

- Idempotent: importing the same `chatId` twice returns the existing Nuncio session (no duplicate).
- A Nuncio session created via handoff has `provider: "cursor"` (existing) but a new `cursor_backend: "cli"` field + `cursor_chat_id`. Existing SDK sessions get `cursor_backend: "sdk"` (backfilled to NULL → treated as `sdk`).
- No agent loop is started at import time. The session is just a row + (later) hydrated transcript.
- FSM starts at `IDLE` (not `CREATED` — there's no new run pending).

## Requirements

### Functional
- `POST /api/sessions/handoff { cursorChatId, workspace, title? }` → `SessionDto`.
- Validate `cursorChatId` exists on disk under the workspace's project slug. 404 if not.
- If a session with `(cursor_backend='cli', cursor_chat_id=chatId)` already exists → return it (200, not 201).
- New session row: `provider: 'cursor'`, `cursor_backend: 'cli'`, `cursor_chat_id`, `workspace`, `status: 'IDLE'`, `title` (override or derived from transcript).
- Reject if `cursor_chat_id` is already linked to a session with `cursor_backend='sdk'` (shouldn't happen, but guard).

### Non-functional
- DB migration is guarded by `PRAGMA table_info` checks (no migration framework).
- Backfill: existing rows get `cursor_backend = NULL` (read as `'sdk'` in service code).
- Unique index on `(cursor_chat_id)` WHERE `cursor_backend = 'cli'` — prevents duplicate imports at the DB layer.
- Handoff must not spawn any subprocess (Phase 3's job).

## Architecture

### Schema

```sql
ALTER TABLE sessions ADD COLUMN cursor_backend TEXT;
ALTER TABLE sessions ADD COLUMN cursor_chat_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_cli_chat_unique
  ON sessions(cursor_chat_id) WHERE cursor_backend = 'cli';
```

Both `ALTER`s guarded by `PRAGMA table_info(sessions)` checks in `DatabaseService.migrate()`.

### Service flow

```
SessionsService.handoff({ cursorChatId, workspace, title? })
  1. CursorLocalSessionsService.find(chatId, workspace) → must exist (reuse Phase 1 service)
  2. SessionsRepository.findByCursorChatId(chatId, 'cli') → if found, return it
  3. Derive title (override ?? Phase 1 service title)
  4. SessionsRepository.create({ provider: 'cursor', cursorBackend: 'cli', cursorChatId, workspace, status: 'IDLE', title })
  5. Return SessionDto
```

### Routing implication (locked, implemented in Phase 3)

`SessionsService.steer()` will branch on `session.cursor_backend`:
- `'cli'` → `CursorCliProvider`
- `'sdk'` or NULL → `CursorAgentProvider` (current)

This phase only adds the column; routing lands in Phase 3.

## Related code files

**Modify:**
- `apps/server/src/db/database.service.ts` — add 2 guarded ALTERs + unique index
- `apps/server/src/sessions/domain/sessions.types.ts` — add `cursor_backend`, `cursor_chat_id` to `SessionRow` + `SessionDto`
- `apps/server/src/sessions/persistence/sessions.repository.ts` — `findByCursorChatId()`, update `create()` + row mapping
- `apps/server/src/sessions/sessions.service.ts` — `handoff()` method
- `apps/server/src/sessions/api/sessions.controller.ts` — `POST /api/sessions/handoff`
- `apps/server/src/cursor-local/cursor-local-sessions.service.ts` — expose `find(chatId, workspace)` for validation

**Create:**
- `apps/server/test/unit/sessions/sessions.handoff.spec.ts`
- `apps/server/test/unit/db/database.service.handoff-migration.spec.ts` (or extend existing db spec)

**Delete:** none.

## Implementation steps

1. TDD: write `sessions.handoff.spec.ts`:
   - New import → row has `cursor_backend='cli'`, `cursor_chat_id`, `status='IDLE'`
   - Re-import same `chatId` → returns same session id, no new row
   - `chatId` not on disk → 404
   - Missing workspace → 400
2. Extend `sessions.types.ts` with the two new fields (Row + DTO + mapping).
3. Update `sessions.repository.ts`: add `findByCursorChatId()`, extend `create()` to accept the new fields, extend row→DTO mapping.
4. Add guarded ALTERs to `DatabaseService.migrate()`; add a migration test that runs migrate() on an empty DB and on a DB with old schema → both end with the columns present.
5. Implement `SessionsService.handoff()` using `CursorLocalSessionsService.find()` for validation.
6. Add `POST /api/sessions/handoff` to controller (thin — delegates to service).
7. Wire `SessionsModule` to import `CursorLocalModule` (for the validation call).
8. `bun run test` + `bun run lint` green.

## Todo

- [ ] TDD handoff spec
- [ ] Extend `sessions.types.ts` (Row + DTO)
- [ ] `findByCursorChatId` + `create()` updates in repository
- [ ] Guarded ALTERs in `DatabaseService.migrate()` + migration test
- [ ] `SessionsService.handoff()` impl
- [ ] `POST /api/sessions/handoff` controller route
- [ ] Wire `CursorLocalModule` into `SessionsModule`
- [ ] `bun run test` + `bun run lint` green

## Success criteria

- `POST /api/sessions/handoff` with a real `chatId` from this Mac creates a session row with `cursor_backend='cli'` and `status='IDLE'`.
- Re-importing the same `chatId` returns the same session id.
- Bogus `chatId` → 404; missing workspace → 400.
- Migration is idempotent (running `migrate()` twice is a no-op).
- Existing SDK sessions still work (backfill path: NULL → read as `'sdk'`).
- `bun run test` green.

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Existing DB on dev machines missing the columns | Guarded ALTER runs on boot; tested against old-schema fixture |
| Unique index conflicts with existing NULLs | Partial index `WHERE cursor_backend = 'cli'` — NULLs don't conflict |
| `cursor_chat_id` collision with SDK sessions | Service rejects if a `'sdk'` row already has the same `cursor_chat_id` (defensive) |
| Handoff called while IDE agent is RUNNING on that chat | Phase 6 adds active-run detection; this phase returns the row optimistically |

## Security considerations

- `workspace` must be absolute and must resolve to a real project slug (no traversal).
- `cursorChatId` validated against disk before insert — can't create sessions for arbitrary UUIDs.
- No secret values stored in the new columns.

## Next steps

- Phase 3 implements `CursorCliProvider` and wires steer routing on `cursor_backend`.
- Phase 4 hydrates the transcript into the event log.
