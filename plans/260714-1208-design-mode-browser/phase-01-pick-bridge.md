# Phase 01 — Pick bridge (Desktop)

**Status:** pending  
**Priority:** P0  
**Depends on:** none  
**Brief:** [product-brief.md](./product-brief.md)

## Overview

Enable Design Mode picking inside the Electron `BrowserView`: inject a guest script that highlights on hover, intercepts click, extracts element identity + crop, and notifies the renderer via IPC — then restore keyboard focus to the React overlay host.

## Requirements

- IPC surface (additive on existing `nuncioDesktop.browser`):
  - `designModeEnter(id)` / `designModeLeave(id)` — inject/remove picker; toggle click interception
  - Event/callback: `onDesignModePick(payload)` → renderer
  - After pick: main focuses app window so renderer can focus overlay input
- Pick payload (minimum):
  - `tag`, `id`, `className`, `xpath` or `cssPath`, `outerHTML` (truncated), subset of computed styles, `bbox` (viewport CSS px)
  - `cropPngBase64` (element screenshot) when feasible via `webContents.capturePage` clipped to bbox, or CDP screenshot
- Guest click does not navigate/submit while Design Mode active
- Re-inject after in-page navigation (`did-finish-load` / `did-navigate-in-page`)

## Architecture notes

- Prefer `webContents.executeJavaScript` injection over full CDP Overlay domain for MVP (KISS).
- `capturePage` with rect derived from BrowserView bounds + element bbox.
- Sandboxed guest: no nodeIntegration; script string owned by main process.

## Related files

| Action | Path |
|---|---|
| Edit | `apps/desktop/src/main.js` |
| Edit | `apps/desktop/src/preload.js` |
| Edit | `apps/desktop/test/main-dev-mode.test.js` (or new design-mode test) |
| Edit | `apps/web/src/components/browser-panel.tsx` (bridge types only if needed) |

## Implementation steps

1. **Red:** Desktop test — `designModeEnter` installs handler; simulated pick returns payload shape; `designModeLeave` clears.
2. Implement inject/remove + IPC event to renderer.
3. Implement crop capture best-effort (fail soft: identity without image).
4. Focus restore: after pick, `mainWindow.webContents.focus()`.
5. Re-inject on navigation while Design Mode flag set per browser id.

## Todo

- [ ] IPC contract documented in preload + types
- [ ] Injected picker (hover + click intercept)
- [ ] Pick payload + optional crop
- [ ] Focus restore after pick
- [ ] Re-inject on navigate
- [ ] Desktop unit/integration test for enter/leave/pick shape

## Success criteria

- From a test harness or manual Desktop build: enter Design Mode → click element → renderer receives one pick; focus returns to window; leave restores normal clicks.

## Risks

| Risk | Mitigation |
|---|---|
| SPA wipes DOM listeners | Re-inject on navigate + periodic check optional later |
| Cross-origin / iframe | Slice 1: top frame only; ignore iframe picks |
| Shadow DOM | `composedPath()` / pierce open shadow; closed shadow = skip with toast later |
| capturePage HiDPI mismatch | Scale bbox by `webFrame`/`display` factor; test on Retina |

## Rollback

Revert desktop IPC + injection; no server schema change in this phase.

## Next

[phase-02-overlay-steer.md](./phase-02-overlay-steer.md)
