# Phase 5 — Desktop: tray mode + farewell broadcast

`apps/desktop` + one small server addition. Depends only on the farewell frame shape
(`{ notice: "server_shutdown" }`, frozen in plan.md) — can land in parallel with Phase 4.

## 1. Farewell broadcast (server)

- `sessions.ws.ts`: `attachSessionsWebSocketServer` returns the `wss`; add
  `broadcastNotice(wss, notice)` helper — iterate `wss.clients`, send `{ notice }` to OPEN sockets.
- `main.ts` shutdown handler (lines ~74-97): call `broadcastNotice(wss, 'server_shutdown')`
  FIRST, then the existing `disposeAll()` → `app.close()`. Sockets flush a tiny frame before the
  server dies; best-effort try/catch (never block shutdown).
- Update `docs/ws-relay-contract.md`: additive `notice` frame, v1-compatible (clients must ignore
  unknown top-level keys — already true of both clients).

## 2. Tray / menu-bar mode (`apps/desktop/src/main.js`)

**Shell settings** (new `src/shell-settings.js`, same pattern as `server-profiles.js`):
`<userData>/shell-settings.json` → `{ closeToTray: true }` default; `load/save` with corrupt-file
fallback.

**Tray**: created at `whenReady` when `closeToTray` — template icon (menu-bar mono asset in
`apps/desktop/build/`), menu:
- "Open Nuncio" → `mainWindow.show()` (create if null, existing `activate` logic reused)
- "Pair mobile device" → show window + navigate the webContents to settings remote-access section
- separator, "Quit Nuncio" → `app.quit()`

**Close-vs-quit rewiring** (the core change):
- `let quitting = false`; `app.on('before-quit', () => { quitting = true; ... })` (existing
  daemon-stop logic stays).
- `mainWindow.on('close', (e) => { if (closeToTray && !quitting) { e.preventDefault();
  mainWindow.hide(); } })` — macOS AND Windows/Linux: hide to tray, daemon untouched.
- `window-all-closed`: `if (!closeToTray && process.platform !== 'darwin') app.quit()` —
  with tray on, never quit here.
- macOS: `app.dock.hide()` is NOT wanted (Oscar uses the dock); keep dock icon, hide window only.

**Single-instance lock** (new, required once the app lives in the background):
`app.requestSingleInstanceLock()` at top; loser quits; winner's `second-instance` handler
shows/focuses the window. Without this a second launch spawns a second daemon on another port —
exactly what stable-port pairing must not race with.

**Toggle in UI**: settings General section switch → IPC `shell:get-settings` /
`shell:set-settings` via preload (`window.nuncioDesktop.shell`), rebuild tray on change.
Rebuild tray menu on updater state change too (existing `onStateChange` hook rebuilds menus).

## 3. Files

| File | Change |
|------|--------|
| `apps/server/src/sessions/api/sessions.ws.ts` | `broadcastNotice` export |
| `apps/server/src/main.ts` | farewell before close |
| `docs/ws-relay-contract.md` | `notice` frame |
| `apps/desktop/src/shell-settings.js` (+test) | new |
| `apps/desktop/src/main.js` | tray, close-to-tray, single-instance |
| `apps/desktop/src/preload.js` | `shell` IPC surface |
| `apps/desktop/build/trayTemplate*.png` | tray icons (16/32 template) |
| `apps/web` General settings | closeToTray switch (desktop-gated via `nuncioDesktop.marker`) |

## 4. Tests + verify

- `shell-settings.test.js`: defaults, round-trip, corrupt file fallback (mirror
  `server-profiles` tests).
- Server unit: `broadcastNotice` sends to OPEN sockets only; shutdown handler order (notice
  before close) — assert with a fake wss.
- Core relay spec (Phase 4's `onNotice`) already pins the client side.
- Manual smoke (desktop app, packaged-dev or `bun run dev`):
  1. Close window → menu bar icon present, `curl /api/health` still 200, mobile still streaming.
  2. Reopen from tray → same session, no daemon restart (same port/pid).
  3. Cmd+Q → mobile flips to "Desktop offline" within ~1 s (farewell), daemon pid gone.
  4. Launch app twice → second instance focuses the first, no second daemon.

## Edge cases

- Farewell must NOT wait for socket flush acks — fire and close; the 1 s figure is best-effort.
- Daemon crash (not user quit) sends no farewell — mobile falls back to heartbeat timeout +
  reconnect backoff; that's correct behavior (desktop may auto-restart the daemon, supervisor
  already retries 3×).
- Tray icon on Windows needs `.ico`; electron-builder already produces platform assets — reuse
  that pipeline for the tray asset.
- Updater quits the app to install: `quitting` flag must be set by updater path too
  (`before-quit` covers it — verify in smoke 3).
