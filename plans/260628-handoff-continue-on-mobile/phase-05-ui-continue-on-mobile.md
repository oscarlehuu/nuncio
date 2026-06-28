# Phase 05 — UI: Continue on Mobile

**Priority:** P1 (user-facing — the whole feature is invisible without this)
**Status:** Not started
**Depends on:** Phase 1 (list API), Phase 2 (handoff API), Phase 4 (transcript visible after import)
**Estimated:** 1.5 days
**Lane:** B (frontend)

## Context Links

- [Plan overview](./plan.md)
- [Phase 1](./phase-01-list-local-sessions.md) — `GET /api/cursor/local-sessions`
- [Phase 2](./phase-02-handoff-import.md) — `POST /api/sessions/handoff`
- Existing patterns: `apps/web/src/components/home-view.tsx`, `model-picker.tsx` (DropdownMenu patterns), `project-picker.tsx`

## Overview

Phone-first flow: Home → "Continue on Mac" → pick one in-progress Cursor chat → Import → land in SessionDetail with the old transcript visible → send a new steer that streams back over SSE. Matches the mockup's mobile composer UX; uses shadcn primitives already in the repo.

## Key insights

- Single-select by default (one handoff = one task). Multi-select is a later enhancement, not v1.
- Picker shows: title, preview, relative time (`5m ago`), message count, "Already on Nuncio" badge if `alreadyImported`.
- If `alreadyImported` and user taps → navigate to the existing Nuncio session (no re-import).
- Import is optimistic: show a "Resuming…" state, then navigate to SessionDetail.
- SessionDetail shows an "Imported from Cursor" badge when `cursorBackend === 'cli'` (requires the DTO field to flow through — confirm Phase 2's `SessionDto` includes it).
- Mobile-first: picker is a `Sheet` (bottom sheet on iOS) or a full-screen dialog; reuse the `Sheet` primitive from `components/ui/sheet`.

## Requirements

### Functional
- "Continue on Mac" button on `HomeView` (next to the composer or in a header row).
- Tapping it opens `HandoffPicker`:
  - Step 1: workspace picker (reuse `ProjectPicker` combobox — same `NUNCIO_PROJECT_ROOTS` data, or a path input).
  - Step 2: list from `GET /api/cursor/local-sessions?workspace=…` — radio-select, sorted by recency.
  - Step 3: "Import" button → `POST /api/sessions/handoff { cursorChatId, workspace }`.
- On success: close picker, navigate to `/sessions/<id>` (the new Nuncio session).
- If the picked session has `alreadyImported: true`, the "Import" button becomes "Open" → navigate to `nuncioSessionId`.
- SessionDetail: badge "Imported from Cursor" when `cursorBackend === 'cli'`; the existing transcript + steer composer work unchanged (SSE already generic).
- Loading + empty + error states for the picker.

### Non-functional
- Mobile-first layout (iPhone PWA safe areas).
- Uses existing shadcn primitives (`Sheet`, `Button`, `Badge`, `Command`/`Popover` for the workspace picker).
- `cn()` for class merging (no template-string concat).
- Icons via `lucide-react` (e.g. `ArrowRightLeft` for handoff).
- All API calls via `lib/api.ts` (no inline `fetch`).

## Architecture

### New files

```
apps/web/src/components/
  handoff-picker.tsx          # Sheet with workspace + session list + import
apps/web/src/lib/
  handoff-api.ts              # fetchLocalCursorSessions(), handoffSession() — or extend api.ts
```

### Data flow

```
HomeView
  └─ [Continue on Mac] → opens HandoffPicker (Sheet)
       └─ ProjectPicker (workspace)
            └─ fetchLocalCursorSessions(workspace) → list
                 └─ select 1 → [Import/Open]
                      └─ handoffSession({cursorChatId, workspace})
                           └─ navigate(`/sessions/${id}`)
```

### State

`HandoffPicker` owns: `workspace`, `sessions[]`, `selectedChatId`, `loading`, `error`. Lifted no further than needed — it's a transient modal.

## Related code files

**Create:**
- `apps/web/src/components/handoff-picker.tsx`
- `apps/web/src/components/handoff-picker.spec.tsx`
- `apps/web/src/lib/handoff-api.ts` (or extend `api.ts`)
- `apps/web/src/lib/handoff-api.spec.ts`

**Modify:**
- `apps/web/src/components/home-view.tsx` — add "Continue on Mac" button + picker wiring
- `apps/web/src/components/home-view.spec.tsx` — cover button → picker open
- `apps/web/src/components/session-detail.tsx` — "Imported from Cursor" badge
- `apps/web/src/components/session-detail.spec.tsx` — badge renders for `cursorBackend='cli'`
- `apps/web/src/lib/api.ts` — `SessionDto` type adds `cursorBackend?` (mirror Phase 2 server DTO)
- `apps/web/src/App.tsx` — navigation on successful import

**Delete:** none.

## Implementation steps

1. TDD `handoff-api.spec.ts`: `fetchLocalCursorSessions(workspace)` calls `GET /api/cursor/local-sessions?workspace=…` and returns typed items; `handoffSession({cursorChatId, workspace})` calls `POST /api/sessions/handoff` and returns `SessionDto`.
2. Implement `handoff-api.ts` (or extend `api.ts`).
3. TDD `handoff-picker.spec.tsx`:
   - Renders workspace picker + empty state initially
   - After workspace selected → fetch → list renders with title/preview/time
   - Select + Import → calls `handoffSession` → on success calls `onImported(sessionId)`
   - `alreadyImported: true` item → button says "Open" → calls `onOpen(sessionId)`
   - Error state renders message
4. Implement `handoff-picker.tsx` with `Sheet` + `ProjectPicker` + list + import button.
5. TDD `home-view.spec.tsx`: "Continue on Mac" button opens picker.
6. Wire button into `home-view.tsx`.
7. TDD `session-detail.spec.tsx`: badge for `cursorBackend='cli'`.
8. Add badge to `session-detail.tsx`.
9. Wire `App.tsx` navigation: `onImported(id)` → `setView({ name: 'session', id })`.
10. `bun run --filter @nuncio/web test` + `lint` + `build` green.

## todo

- [ ] TDD `handoff-api` spec + impl
- [ ] TDD `handoff-picker` spec + impl (Sheet + workspace + list + import/open)
- [ ] "Continue on Mac" button in `home-view.tsx` + spec
- [ ] "Imported from Cursor" badge in `session-detail.tsx` + spec
- [ ] `App.tsx` navigation on import
- [ ] `SessionDto` type update in `lib/api.ts`
- [ ] Web test + lint + build green
- [ ] Manual smoke on Tailscale (phone) against real Mac transcripts

## Success criteria

- On phone PWA: Home → "Continue on Mac" → pick workspace → see real chats → select one → "Import" → land in SessionDetail with old transcript visible → type steer → stream appears.
- `alreadyImported` sessions show "Open" and navigate without re-importing.
- Empty workspace / error states render gracefully.
- Mobile safe areas respected.
- Web test suite green.

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Workspace picker on phone is fiddly | Reuse existing `ProjectPicker` combobox; add "Browse folders…" fallback (already exists via `/api/fs/dirs`) |
| Long transcript lists slow the picker | Server already limits to 20; virtualize if needed in a later pass |
| User expects two-way sync | UI copy is explicit: "Continue on Mac" (one-way handoff), no sync promise |
| `SessionDto.cursorBackend` not plumbed through | Confirm in Phase 2; this phase's spec asserts on it |

## Security considerations

- No new secrets in the frontend.
- Workspace paths shown in the picker are the user's own (from `NUNCIO_PROJECT_ROOTS` or folder browser) — no exposure beyond what `/api/fs/dirs` already returns.
- Don't render raw transcript `<user_query>` wrappers in the picker preview (server strips, but client defends too).

## Next steps

- Phase 6 hardens errors, dedupe edge cases, updates docs, ships.
