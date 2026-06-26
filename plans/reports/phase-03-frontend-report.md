# Phase 03 Frontend Report

**Branch:** `cursor/phase-03-frontend-5323`  
**Base:** `cursor/phase-02-combined-5323`  
**Status:** DONE  
**Verify:** `npm run build -w apps/web` — PASS

## Delivered

### api.ts
- Extended `SessionStatus` with `PAUSED`, `ARCHIVED`
- Added `steerSession`, `pauseSession`, `archiveSession`, `fetchModels`
- `createSession(prompt, model?)` passes optional model to POST body
- `statusLabel` covers new states

### model-providers.ts + model-picker.tsx
- Ported mockup `PROVIDERS` nested structure (Pi → groups → models)
- 3-level dropdown: Provider → Group → Model with search on groups
- `fetchModels()` with static `FALLBACK_PROVIDERS` fallback

### home-view.tsx
- Integrated `ModelPicker`; selected model passed to `createSession`

### session-detail.tsx
- Steer composer (textarea + send) matching mockup pattern
- Pause / archive header actions
- Steer disabled when `RUNNING` or `ARCHIVED`

### App.tsx
- Wired `handleSteer`, `handlePause`, `handleArchive`
- Refreshes session list after lifecycle actions; archive returns to home

### status-dot.tsx (+ sidebar)
- `PAUSED` / `ARCHIVED` gray dots per mockup (`text-3`, archived at 40% opacity)
- `RUNNING` green pulse, `IDLE` info blue

## Files touched
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/model-providers.ts` (new)
- `apps/web/src/components/model-picker.tsx` (new)
- `apps/web/src/components/home-view.tsx`
- `apps/web/src/components/session-detail.tsx`
- `apps/web/src/components/status-dot.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/index.css`

## Dependencies
- Backend Lane A must expose:
  - `POST /api/sessions/:id/steer` `{ message }`
  - `POST /api/sessions/:id/pause`
  - `POST /api/sessions/:id/archive`
  - `GET /api/models`
- UI degrades gracefully: model picker uses fallback catalog if `/api/models` fails

## Unresolved
- None for frontend scope
