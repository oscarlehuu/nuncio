# Phase 02 — Overlay chat + steer open session

**Status:** pending  
**Priority:** P0  
**Depends on:** [phase-01-pick-bridge.md](./phase-01-pick-bridge.md)  
**Brief:** [product-brief.md](./product-brief.md)

## Overview

Design Mode UI in the browser panel: reserve a bottom strip for overlay chat, keep focus there, insert `[component N]` chips on pick, serialize prompt + snapshots, call existing `onSteer` / steer API for the **current session only**.

## Requirements

- Toggle Design Mode (button + optional Cmd+Shift+D when dock focused)
- When on: shrink BrowserView bounds to leave overlay strip; show overlay chat; focus input
- Click pick → insert chip at caret; increment N; **do not** require Cmd/Shift
- After pick: refocus overlay input (pairs with phase-01 focus restore)
- Send / Enter → `steer(sessionId)` with:
  - User-visible message (chips as typed)
  - Delimited identity blocks for each component
  - Image attachments = crops (and optional one viewport shot)
- Disabled Send when: no session, archived, or empty (no text and no chips)
- **Never** `POST /api/sessions` create from this path
- Esc or toggle off: leave Design Mode, `designModeLeave`, restore bounds

## Data flow

1. User types in overlay (controlled chip model or contenteditable).
2. Pick IPC → append chip token + store `DesignModeComponent[]` in React state keyed by N.
3. On Send: build `message` string + `MessageAttachment[]` from crops → `onSteer(message, attachments)` already wired from `App` → session-detail.
4. Clear overlay draft after successful steer (keep Design Mode on unless user toggles off).

## Related files

| Action | Path |
|---|---|
| Edit | `apps/web/src/components/browser-panel.tsx` |
| Add | `apps/web/src/components/design-mode-overlay.tsx` (keep panel < ~200 lines) |
| Add | `apps/web/src/lib/design-mode-serialize.ts` (+ `.spec.ts`) |
| Edit | `apps/web/src/components/session-detail.tsx` — pass `onSteer` into browser panel / design mode |
| Edit | `apps/web/src/components/browser-panel.spec.tsx` |
| Maybe | `packages/core` only if shared serialize helpers needed — prefer web-local first |

## Implementation steps

1. **Red:** serialize unit tests — chips + identity → message shape; no create-session.
2. **Red:** overlay component tests — type, simulate pick, chip appears, Send calls steer mock with session id.
3. Wire toggle + bounds reserve in `DesktopBrowserPanel`.
4. Wire pick subscription from preload (expose `onPick` via `ipcRenderer.on` in preload bridge).
5. Connect `onSteer` from session-detail; hard-code no create.
6. Cap components (e.g. 8) and HTML size; toast when capped.

## Todo

- [ ] Overlay UI + focus management
- [ ] Chip insert model + Backspace removes chip token
- [ ] Serialize helper + unit tests
- [ ] Steer-only Send path
- [ ] Bounds reserve when Design Mode on
- [ ] Shortcut toggle (optional same PR)

## Success criteria

- Manual: two-chip spatial sentence steers open session; sidebar session count unchanged; transcript shows prompt + images.
- Automated: serialize + overlay Send mock green.

## Risks

| Risk | Mitigation |
|---|---|
| Main composer vs overlay confusion | Overlay only while Design Mode; copy clarifies “Steers this session” |
| RUNNING session | Reuse existing queue / mid-run steer; toast if rejected |
| Huge HTML blows context | Truncate outerHTML + styles subset |

## Rollback

Feature-flag or remove toggle; desktop leave Design Mode is no-op if UI gone.

## Next

[phase-03-tests-docs.md](./phase-03-tests-docs.md)
