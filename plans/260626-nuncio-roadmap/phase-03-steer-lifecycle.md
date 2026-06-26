# Phase 03 — Steer, Lifecycle, Model Picker

**Status:** Planned · **Blocked by:** Phase 2 complete  
**Depends on:** Phase 2

## Scope
- `POST /api/sessions/:id/steer`
- FSM: `PAUSED`, `ARCHIVED`
- Model picker (Provider → Group → Model) from mockup
- `GET /api/models`, optional Bearer token auth

## Agent ownership
- **A:** `apps/server/src/sessions/**`, `auth/**`
- **B:** `model-picker.tsx`, `session-detail.tsx`, `home-view.tsx`
- **C:** tests + FSM specs

## Pi SDK
`session.prompt(msg, { streamingBehavior: 'steer' | 'followUp' })`
