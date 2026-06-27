# Phase 03 Backend Report (Lane A)

**Status:** DONE
**Branch:** `cursor/phase-03-backend-5323`
**Commit:** `f191747` — feat(server): steer, pause, archive, models API
**Base:** `cursor/phase-02-combined-5323`

## Delivered

### FSM (`session.types.ts`, `session-fsm.ts`)
- Added `PAUSED`, `ARCHIVED` to `SessionStatus`
- Transitions: `RUNNING|IDLE → PAUSED`, `PAUSED → RUNNING` (steer), `IDLE|PAUSED|ERROR → ARCHIVED`, `ARCHIVED` terminal

### Endpoints (`sessions.controller.ts`)
- `POST /api/sessions/:id/steer` `{ message }`
- `POST /api/sessions/:id/pause`
- `POST /api/sessions/:id/archive`
- `GET /api/models` — new `ModelsModule` with Pi `ModelRegistry` when auth exists, else `STATIC_MODEL_PROVIDERS` (mockup-aligned)

### SessionsService
- `steer()`, `pause()`, `archive()`
- `list(includeArchived?)` — excludes `ARCHIVED` by default; `?includeArchived=1|true` opt-in
- Status + `steer_message` events via agent layer; pause/archive emit `status` events

### PiAgentService
- `Map<sessionId, PiSessionHandle>` keeps Pi session alive after first run for steer
- `steer()` calls `session.prompt(msg, { streamingBehavior: 'steer' })` on retained handle
- `dispose()` on archive; mock fallback when no auth / no handle

### MockAgentService
- `steer()` appends `steer_message` + new assistant stream (mock reply)

### CreateSessionDto
- `model` field accepted and persisted on create (unchanged contract, now wired through controller)

## Verify

```
npm run build -w apps/server  # PASS (after rm -rf apps/server/dist if ENOTEMPTY)
npm test -w apps/server       # PASS — 15 tests (includes untracked Lane C service spec locally)
```

## Lane C notes

FSM spec + integration tests **not committed** (Lane C ownership). Recommended additions on `session-fsm.spec.ts`:
- `RUNNING → PAUSED`, `IDLE → PAUSED`, `PAUSED → RUNNING`, `IDLE|PAUSED|ERROR → ARCHIVED`, terminal `ARCHIVED`

`app.spec.ts` phase-3 lifecycle tests should land with Lane C.

## Unresolved

- Full monorepo `npm run build` still needs Lane B web updates for `PAUSED`/`ARCHIVED` in `status-dot.tsx` and `api.ts` status maps.
