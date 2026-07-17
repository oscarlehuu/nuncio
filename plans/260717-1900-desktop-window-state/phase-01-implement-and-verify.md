# Implement and verify desktop window state

## Context links

- [Lifecycle research](../reports/researcher-2026-07-17-desktop-window-lifecycle.md)
- [Tests and release research](../reports/researcher-2026-07-17-desktop-window-tests-release.md)
- [`apps/desktop/src/main.js`](../../apps/desktop/src/main.js)
- [`AGENTS.md`](../../AGENTS.md)
- [`docs/testing-and-verification.md`](../../docs/testing-and-verification.md)

## Overview

Priority: medium. Status: complete. Added failure-soft, desktop-only shell persistence without renderer, preload, API, database, minimized, fullscreen, or live display-hotplug scope.

## Requirements and design

- Save channel-isolated state at `<app.getPath('userData')>/window-state.json` using best-effort atomic temp-write plus rename.
- Add a small CommonJS helper for load/save, bounds fitting, and window event management; keep `main.js` as lifecycle orchestration.
- Accept only finite `x/y`, positive finite `width/height`, and strict `maximized === true`; round geometry and allow negative origins.
- Use `screen.getDisplayMatching(savedBounds).workArea`. Clamp size to the work area while retaining `960x640`; clamp `x/y` to full containment, or pin to the work-area origin when an axis is smaller than the minimum. This rehomes wholly off-screen/removed-monitor state onto a current display.
- Pass restored normal bounds to `BrowserWindow`, attach event management, then maximize when requested. Missing/corrupt state, unavailable `userData`/`screen`, or I/O failure must create the existing default window.
- Snapshot `getNormalBounds()` on trailing-debounced move/resize (about 250 ms); persist maximize/unmaximize immediately; flush before close-to-tray interception and before async daemon shutdown; dispose timers/listeners on `closed`.

## Files

- Create `apps/desktop/src/window-state.js` and `apps/desktop/test/window-state.test.js`.
- Update `apps/desktop/src/main.js` and `apps/desktop/test/main-dev-mode.test.js`.
- Update `README.md`, `docs/product-surfaces.md`, `docs/system-architecture.md`, and add one `.changeset/*.md` fragment.

## Red -> green -> refactor

1. Extend only the `main-dev-mode.test.js` harness with isolated `userData`, fake `screen`, normal-bounds/maximize methods, and controllable timers. Preseed valid state; assert constructor geometry and one maximize call. Run it and record a real assertion failure, not an import/compile error.
2. Add the minimal helper and startup wiring to make that case green.
3. Write failing helper tests for missing/corrupt/invalid state, negative-origin displays, round-trip and unwritable paths, unchanged in-area bounds, removed-monitor rehoming, oversized/work-area changes, and work areas below the minimum. Implement only enough normalization, clamping, and atomic persistence to pass.
4. Write failing fake-timer tests proving move/resize coalescing, immediate maximize/unmaximize persistence, `getNormalBounds()` use, and forced flush/dispose behavior. Implement the manager; never use sleeps.
5. Add failing lifecycle regressions for close-to-tray flush-before-hide, two-phase `before-quit`, update-close ordering, corrupt/unavailable fallbacks, and destroy/activate recreation. Wire the manager through every `createWindow()` path, then refactor with all focused tests green.

## Verification and acceptance

Run from the repository root:

```bash
bun test apps/desktop/test/main-dev-mode.test.js apps/desktop/test/window-state.test.js
bun run --filter @nuncio/desktop test
bun run --filter @nuncio/desktop lint
bun run --filter @nuncio/desktop smoke
bun run gate
bun run gate:full
bun run check-changeset
git diff --check
```

For Computer Use, first confirm canonical ports 3000/5173 are free. Start server with `NUNCIO_ENV_FILE=/dev/null`, `NUNCIO_FORCE_MOCK=1`, and a temporary `NUNCIO_DATA_DIR`; start web on 5173; launch source Electron with `NUNCIO_DESKTOP_DEV=1 --user-data-dir=<same temporary root>/electron-user-data`. With screenshots/state evidence:

1. Set a distinctive normal rectangle, quit with Cmd+Q, relaunch, and confirm position/size.
2. Maximize, Cmd+Q, relaunch, and confirm maximized.
3. Unmaximize to a second rectangle, Cmd+Q, relaunch, and confirm non-maximized normal bounds.
4. Use synthetic-display tests for removed-monitor acceptance; optional live unplug only if non-disruptive. Stop all processes and keep temporary evidence until review.

## Risks, security, and release

- Persistence is local shell geometry only: no secrets, IPC, renderer exposure, SQLite, or user-selected project data. Treat all disk input as malformed; failure must never block daemon/error-window startup.
- Preserve close-to-tray, updater, single-instance, daemon shutdown, BrowserView, and PTY cleanup ordering.
- Document desktop persistence in README, the Desktop surface map, and the `userData` architecture section. Do not edit `CHANGELOG.md` directly; no ADR/AGENTS change unless implementation changes architecture.
- Add patch changeset: `bun run add-changeset patch "Remembered the desktop window's size, position, and maximized state across restarts."` The current changeset detector misses desktop source, so the fragment remains mandatory by policy.

## Review and delivery

After all proof is green, run a Codex xhigh review and fix every blocker. Stage only task files; commit conventionally, push `fix/desktop-window-state`, open a PR to `dev` with test/Computer Use evidence and the changeset, wait for green CI/desktop smoke, then merge. Do not bypass gates or merge a red PR.

## Next steps

After merge, clean the worktree/branch. Track live display-removal handling or changeset-detector coverage only as separate, reproduced follow-ups.
