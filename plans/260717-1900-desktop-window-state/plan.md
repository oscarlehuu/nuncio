# Desktop window state persistence

Status: implementation complete; delivery pending
Priority: medium
Target: `fix/desktop-window-state` -> `dev`

## Goal

Remember the desktop window's normal position, size, and maximized state across real quits while guaranteeing a usable window after display-layout changes.

## Decisions

- Store `{ bounds: { x, y, width, height }, maximized }` at `<userData>/window-state.json`; keep it separate from SQLite and `shell-settings.json`.
- Persist normal bounds only (`getNormalBounds()`); never persist minimized/fullscreen state or display IDs.
- Validate finite geometry, allow negative display coordinates, round to integers, and reject non-positive dimensions.
- Select the current display with `screen.getDisplayMatching(savedBounds)` and clamp to its `workArea`.
- Preserve minimum `960x640`; if the work area is smaller, pin the window to its origin so the title bar remains reachable.
- Construct at validated normal bounds, attach listeners, then reapply maximization.
- Debounce move/resize saves; flush on maximize changes, close, and before quit. Any read/write/screen failure falls back to the current `1280x900` startup.

## Phase

- [x] [Implement and verify](./phase-01-implement-and-verify.md) — red tests, helper and lifecycle wiring, isolated desktop acceptance, release delivery.

## Completion gates

- [x] Focused tests show red for behavioral assertions, then green without sleeps or weakened coverage.
- [x] Desktop tests/lint/smoke, `bun run gate`, and `bun run gate:full` pass.
- [x] Isolated Computer Use proves normal, maximized, and unmaximized relaunch behavior.
- [x] README/architecture/surface docs and a patch changeset are synchronized.
- [x] Clean Codex xhigh review; blockers fixed before commit.
- [ ] Focused conventional commit, push, PR to `dev`, green CI, then merge.

## Unresolved questions

None.
