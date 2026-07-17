# Desktop window lifecycle research

## Recommendation

Add a small, defensive `apps/desktop/src/window-state.js` module and keep geometry in
`<app.getPath('userData')>/window-state.json`, separate from `shell-settings.json`:

```json
{
  "bounds": { "x": 120, "y": 64, "width": 1280, "height": 900 },
  "maximized": false
}
```

Do not persist a display id, minimized state, or fullscreen state. Display ids/layouts can change;
validate the saved normal bounds against the current Electron `screen` work area on every window
creation. This is desktop-shell state, not shared Nuncio/session state, so it should not use SQLite or
`NUNCIO_DATA_DIR`.

## Current lifecycle and seams

- `apps/desktop/src/main.js:32-35` already states that dev/stable have separate **window state** via
  `userData`; packaged startup sets the channel-specific app name before any `userData` read at
  `main.js:49-51`. Builder config also gives stable/dev distinct app identities
  (`apps/desktop/electron-builder.config.cjs:3-7,15-17`). A `window-state.json` under `userData`
  therefore follows the intended channel isolation.
- Every first window, daemon-error window, tray recreation, and macOS activation funnels through
  `createWindow()` (`main.js:96-160`, `537-558`, `204-214`, `1023-1104`, `1145-1149`). One hook in
  `createWindow()` covers all paths; no renderer/preload/API change is needed.
- The constructor currently hard-codes only `1280x900` plus minimum `960x640`, with no `x`, `y`, or
  maximize restore (`main.js:96-107`).
- An ordinary close is prevented and hidden when close-to-tray is enabled (`main.js:110-120`), while
  final destruction performs BrowserView/PTY/timer cleanup (`main.js:122-130`). Window state must be
  flushed **before** `preventDefault()`/`hide()`, not only in `closed`.
- A real quit is two-phase: `before-quit` marks quit intent, prevents the first quit, asynchronously
  stops the daemon, then calls `app.quit()` again (`main.js:1176-1196`). Update installation may emit
  window `close` before normal `before-quit`, handled through `before-quit-for-update`
  (`main.js:1169-1174`) and updater callback (`main.js:1118-1124`). Flush on both window `close` and
  the first `before-quit` before daemon shutdown.
- Existing persistence modules are defensive and live under `userData`: path resolution is at
  `main.js:162-182`; load happens after `app.whenReady()` at `main.js:1023-1038`; filesystem failures
  fall back in-memory (`shell-settings.js:25-49`, `server-profiles.js:40-75`). Reuse this posture.
- Do **not** put geometry in `shell-settings.json`: `saveSettings()` intentionally rewrites only
  `{ closeToTray }` (`shell-settings.js:40-46`), and its contract test pins that exact shape
  (`test/shell-settings.test.js:93-97`). Mixing high-frequency geometry with the settings IPC would
  create clobber coupling.
- The VM harness already captures `BrowserWindow` constructor options and native events
  (`test/main-dev-mode.test.js:9-17,18-48,103-175`) and supplies the Electron stub at
  `test/main-dev-mode.test.js:268-340`. It is the right integration seam; add `app.getPath`, `screen`,
  bounds, maximize, and event behavior there.

## Smallest robust design

### Files/functions

1. Create `apps/desktop/src/window-state.js` (pure/CommonJS, no Electron import):
   - `loadWindowState(filePath)` — missing/corrupt/invalid returns `null`.
   - `saveWindowState(filePath, state)` — best-effort atomic temp-write + rename; returns boolean.
   - `fitBoundsToWorkArea(bounds, workArea, minimums)` — finite integer validation and clamping.
   - `manageWindowState(win, filePath, initialState)` — tracks maximize state, debounces geometry
     writes, exposes `flush()` and `dispose()`.
2. Modify `apps/desktop/src/main.js`:
   - add Electron `screen` and `./window-state` imports near `main.js:2-17`;
   - add `resolveWindowStatePath()` beside `resolveServerProfilesPath()` /
     `resolveShellSettingsPath()` (`main.js:162-182`);
   - initialize the path after `app.whenReady()` and before the first `createWindow()`
     (`main.js:1023-1038`);
   - in `createWindow()` (`main.js:96-160`), load state, choose current work area, pass restored
     normal bounds to `BrowserWindow`, attach the manager, then call `win.maximize()` when saved,
     before `loadURL()`;
   - flush before the existing close-to-tray branch (`main.js:115-120`) and at the start of the
     first `before-quit` (`main.js:1176-1188`); dispose/clear the debounce on `closed`.
3. Create `apps/desktop/test/window-state.test.js`; extend
   `apps/desktop/test/main-dev-mode.test.js` only for lifecycle integration.
4. User-visible fix: add a patch changeset and one README feature sentence. No
   `docs/product-surfaces.md` change: this adds no route, Settings section, or second shell.

### Restore/visibility algorithm

Run only after Electron is ready; Electron documents that `screen` is unavailable before then.

1. Accept saved `x`/`y` only when finite (negative coordinates are valid for left/upper displays),
   and `width`/`height` only when finite and positive. Round to integers. Any malformed bounds fall
   back to the current constructor defaults and OS-selected position. Only strict boolean `true`
   restores maximized.
2. Call `screen.getDisplayMatching(savedBounds)` and use its `workArea`, not physical `bounds`, so
   menu bar/Dock/taskbar space is respected. No stale display id is needed.
3. Clamp size to the matched work area while retaining the existing `960x640` minimum. Then clamp
   `x` to `[workArea.x, workArea.x + workArea.width - width]` and `y` equivalently. If a work area is
   smaller than the app minimum, keep the minimum size but pin the top-left to the work-area origin;
   the title bar remains reachable even though full containment is impossible.
4. Instantiate at these **normal** bounds, then maximize. This places the maximized window on the
   correct current display and preserves usable normal bounds for later unmaximize.
5. If `screen`, `getDisplayMatching`, or persistence fails, boot with the existing `1280x900`
   defaults. Window-state failure must never block daemon startup or the error window.

Electron's current APIs support this directly: [`getNormalBounds()` always returns normal-state
bounds, even while maximized/minimized](https://www.electronjs.org/docs/latest/api/browser-window),
and [`screen.getDisplayMatching()` selects the display intersecting the rectangle while `workArea`
excludes OS-reserved space](https://www.electronjs.org/docs/latest/api/screen/). Electron also
defines `userData` as the per-app configuration location
([app docs](https://www.electronjs.org/docs/latest/api/app)). The repo pins Electron 42.5.2
(`apps/desktop/package.json:19-24`).

### Save timing

- Listen to cross-platform `move` and `resize`; trailing-debounce about 250 ms to avoid synchronous
  disk writes for every drag tick.
- Snapshot with `win.getNormalBounds()`, never `getBounds()`, so maximizing cannot overwrite the
  restore rectangle with full-screen-sized geometry.
- Track a boolean from `maximize`/`unmaximize` events and persist those transitions immediately.
  Keep the tracked value across minimize so quit-while-minimized does not accidentally forget a
  prior maximized state.
- `close`: cancel debounce and flush synchronously **before** the existing hide/prevent branch.
- `before-quit`: flush before `event.preventDefault()` and async daemon stop; the eventual second
  quit can flush idempotently. The updater's close-first path is covered by the window `close` flush.
- `closed`: clear timer/listeners. A crash can lose at most the debounce interval; corrupt/partial
  state falls back safely next boot.

## TDD cases

Start red in `apps/desktop/test/window-state.test.js`:

1. missing/null/corrupt/non-object JSON and NaN/infinite/non-positive dimensions return no state;
   negative `x`/`y` are accepted;
2. save/load round-trip exact bounds + maximized; unwritable path is non-fatal;
3. in-work-area bounds stay unchanged, including a display with negative origin;
4. removed-monitor bounds are moved into the current matching work area;
5. resolution/Dock/taskbar change clamps against `workArea`; oversized bounds shrink, while a work
   area below `960x640` keeps its title-bar origin reachable;
6. rapid move/resize events coalesce; maximize/unmaximize save immediately; snapshot uses normal
   bounds; close forces the pending save.

Then red integration cases in `apps/desktop/test/main-dev-mode.test.js`:

1. preseeded `window-state.json` supplies constructor `x/y/width/height`, and saved maximized calls
   `maximize()` once after listener attachment;
2. off-screen saved bounds are clamped through fake `screen.getDisplayMatching()` before construct;
3. close-to-tray still prevents/hides and keeps the daemon, but the state file is already updated;
4. `before-quit-for-update` / two-phase daemon quit still save and are not swallowed;
5. corrupt file or unavailable `userData`/`screen` still creates exactly one default window;
6. destroy + `activate` recreation reuses the last persisted normal bounds without creating a
   competing boot window.

Verification from repo root:

```bash
bun test apps/desktop/test/window-state.test.js apps/desktop/test/main-dev-mode.test.js
bun run --filter @nuncio/desktop test
bun run --filter @nuncio/desktop lint
bun run gate
```

The existing baseline is green: `bun run --filter @nuncio/desktop test` passed 75 tests / 256
assertions on 2026-07-17. The macOS packaged smoke (`apps/desktop/scripts/smoke-desktop.mjs:1-17`
and `.github/workflows/desktop-smoke.yml:1-15,42-50`) remains the final real-Electron boot gate; a
one-time interactive macOS check should cover normal → move/resize → quit/relaunch, maximized →
quit/relaunch, and unplugged-secondary-display relaunch.

## Scope / unresolved questions

- Scope deliberately excludes minimized and native fullscreen restoration; neither was requested.
- No live `display-removed` listener recommended. Startup validation covers stale layouts, and OS
  window managers already rehome live windows; add hot-plug handling only with a reproduced defect.
- Linux Wayland restricts global positioning/inspection in Electron; Nuncio's current packaged
  target is macOS arm64 (`electron-builder.config.cjs:34-40`). The fallback must remain non-fatal.
- Unresolved questions: none.
