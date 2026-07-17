# Desktop window-state tests, launch, and release research

## Recommendation

Implement the behavior in a small filesystem-defensive desktop helper and wire it through the
existing `main.js` VM harness. Persist the last **normal** `{ x, y, width, height }` plus
`maximized`; restore saved geometry only when it intersects a current display work area. Keep the
existing `1280x900` / `960x640` defaults when state is missing, corrupt, invalid, or wholly
off-screen (`apps/desktop/src/main.js:96-107`).

Electron already provides the key primitive: `getNormalBounds()` returns the normal-state bounds
even while maximized/minimized/fullscreen
(`node_modules/.bun/electron@42.5.2/node_modules/electron/electron.d.ts:2822-2829`). Current displays
are available through `screen.getAllDisplays()` (same file `:11943-11945`). This avoids accidentally
persisting the maximized rectangle as the next normal rectangle.

## Existing desktop conventions

- Desktop uses CommonJS source and `bun:test`; package commands are `test = bun test`,
  `lint = oxlint src test scripts`, packaged `smoke`, and stable/dev `dist` variants
  (`apps/desktop/package.json:6-17`). Root `test` includes desktop and `gate` includes root tests;
  `gate:full` adds server e2e + real-browser smoke (`package.json:20-23,38-43`).
- `main.js` currently hard-codes only width/height/minimums and immediately loads the URL
  (`apps/desktop/src/main.js:96-107,159-160`). It already resolves other shell JSON files beneath
  `app.getPath('userData')` and degrades to in-memory state when unavailable
  (`apps/desktop/src/main.js:162-182,1023-1039`).
- Follow the `shell-settings.js` pattern: pure normalization, missing/corrupt/unwritable file is
  non-fatal, recursive parent creation, boolean success from save
  (`apps/desktop/src/shell-settings.js:14-15,25-49`). Its tests use a real `mkdtemp` directory and
  cover defaults, malformed JSON, normalization, round-trip, and write failure
  (`apps/desktop/test/shell-settings.test.js:12-31,47-114`).
- `main-dev-mode.test.js` loads `main.js` in `vm`, records each `BrowserWindow` constructor option,
  and exposes event handlers (`apps/desktop/test/main-dev-mode.test.js:6-17,103-175,246-375`). This
  is the correct integration seam; no real Electron process is needed for red/green tests.
- Close-to-tray matters: ordinary close is prevented and hides the window
  (`apps/desktop/src/main.js:110-120`), proven by
  `apps/desktop/test/main-dev-mode.test.js:684-701`. Acceptance must use **Cmd+Q / Quit Nuncio**,
  not the red close button, to test a true relaunch.
- Packaged dev/stable call `app.setName` before reading `userData`, so their state remains separate
  (`apps/desktop/src/main.js:32-51`). Store the new file under that channel-specific `userData`
  (suggested name: `window-state.json`), not in the shared sessions data directory.

## Proposed TDD sequence and red tests

Start in `apps/desktop/test/main-dev-mode.test.js` so the first red is an **assertion failure**, not
a missing-module/import failure (required by `AGENTS.md:22-27`). Extend only the test harness with a
fake `app.getPath('userData')`, fake `screen.getAllDisplays()`, and fake window methods
`getNormalBounds`, `isMaximized`, and `maximize`.

1. **Red: restores valid state.** Prewrite the state file, boot `runMain`, assert the first
   `BrowserWindow` options contain saved `x/y/width/height`, existing minimums remain, and a saved
   `maximized: true` causes exactly one `maximize()` call.
2. **Red: persists normal bounds and maximized state.** Emit `move`, `resize`, `maximize`, and
   `unmaximize`; assert the persisted file uses `getNormalBounds()` and the current
   `isMaximized()`. Include a close/quit flush if writes are debounced. Never use sleep; inject/fake
   timers (the no-sleep rule is `docs/testing-and-verification.md:207-208`).
3. **Red: stale monitor cannot strand the window.** Give the helper saved coordinates wholly
   outside every synthetic `display.workArea`; assert startup omits/recenters the stale `x/y` and
   uses safe current-display dimensions/defaults. Also prove a valid negative `x` on a display to
   the left is accepted; negative coordinates alone are not invalid.
4. **Red: defensive persistence.** Add `apps/desktop/test/window-state.test.js` once the helper seam
   exists. Cover missing/null path, corrupt/non-object JSON, non-finite/fractional/non-positive
   geometry, oversized/off-screen geometry, valid round-trip, and unwritable parent. Boot must
   continue on every failure, matching shell settings.
5. **Regression: normal bounds survive maximize.** Save a distinctive normal rectangle, maximize,
   persist, reload, and assert startup restores that rectangle then maximizes. Unmaximize, change
   bounds, persist/reload, and assert `maximized: false` plus the new rectangle.
6. **Regression: recreated windows.** Exercise the existing `activate`/tray recreation path so a
   later window uses the same validated state; current recreation is at
   `apps/desktop/src/main.js:199-214,1145-1149`.

Suggested focused commands, from repository root:

```bash
bun test apps/desktop/test/main-dev-mode.test.js
bun test apps/desktop/test/window-state.test.js
bun run --filter @nuncio/desktop test
bun run --filter @nuncio/desktop lint
```

Then gates:

```bash
bun run gate
bun run gate:full
bun run --filter @nuncio/desktop smoke
```

The packaged smoke builds an unsigned app, launches the real binary through CDP, asserts a visible
rendered shell, and performs clean process-group shutdown
(`apps/desktop/scripts/smoke-desktop.mjs:3-17,129-205`). It does **not** currently assert window
geometry. Desktop-source PRs automatically trigger the macOS packaged boot workflow, which runs
that command (`.github/workflows/desktop-smoke.yml:3-16,25-50`).

Baseline verified during this research:

```text
bun run --filter @nuncio/desktop test  -> 75 pass, 0 fail
bun run --filter @nuncio/desktop lint  -> exit 0 (3 existing warnings)
```

## Safe Computer Use acceptance (Mock, isolated state)

First confirm ports 3000/5173 are free; the canonical-port rule applies. Use one temporary root for
both launches so no live Nuncio DB or installed Nuncio/Nuncio Dev window state is touched:

```bash
export NUNCIO_WINDOW_ACCEPT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nuncio-window-state.XXXXXX")"

# terminal A
NUNCIO_ENV_FILE=/dev/null NUNCIO_FORCE_MOCK=1 \
  NUNCIO_DATA_DIR="$NUNCIO_WINDOW_ACCEPT_ROOT/data" \
  bun run --filter @nuncio/server start

# terminal B
NUNCIO_API_ORIGIN=http://localhost:3000 bun run --filter @nuncio/web dev

# terminal C
NUNCIO_DESKTOP_DEV=1 \
  ./apps/desktop/node_modules/.bin/electron \
  --user-data-dir="$NUNCIO_WINDOW_ACCEPT_ROOT/electron-user-data" apps/desktop
```

Why this path: the source dev shell attaches to Vite and does not supervise a second daemon
(`apps/desktop/src/main.js:1040-1056`); `NUNCIO_FORCE_MOCK=1` is the documented zero-credential
provider (`README.md:167-170`, `docs/testing-and-verification.md:49-53`). Packaged mode explicitly
strips forced Mock (`apps/desktop/src/main.js:1065-1083`), so do not use a packaged app for this
interactive Mock check. A detached DevTools window is expected in dev mode (`main.js:1051-1056`).

Computer Use steps:

1. Move the Nuncio app window to a clearly distinctive on-screen position and resize it to a
   distinctive normal size (for example roughly `1100x720`). Capture a screenshot.
2. Quit with **Cmd+Q**. Relaunch terminal C with the same `NUNCIO_WINDOW_ACCEPT_ROOT`. Confirm the
   same normal position/size returns.
3. Maximize with the native green button, Cmd+Q, relaunch; confirm it reopens maximized.
4. Restore/unmaximize, choose a second distinctive normal rectangle, Cmd+Q, relaunch; confirm it
   reopens non-maximized at the second rectangle. This proves maximization did not overwrite normal
   bounds.
5. Prove removed-monitor handling in the synthetic-display unit test. If a secondary display is
   already disposable for the run, an optional live check is: save on that display, remove it,
   relaunch, and confirm the window appears usable on a current display. Do not require disruptive
   display reconfiguration for acceptance.
6. Stop all three processes when done. Preserve the temporary directory until screenshots/state
   evidence are collected; it is the only state touched by this acceptance run.

## Docs, changeset, and release requirements

- **Mandatory changeset: patch.** This is user-visible desktop polish/bug-fix behavior, not a new
  end-to-end workflow. The rubric defaults such changes to patch
  (`AGENTS.md:219-240`; `.changeset/README.md:24-36`). Recommended command:

  ```bash
  bun run add-changeset patch "Remembered the desktop window's size, position, and maximized state across restarts."
  bun run check-changeset
  ```

- **Mandatory README sync.** Document the desktop shell remembering valid window geometry and
  maximized state across launches; README sync is explicitly required by `AGENTS.md:27-35`.
- **Update `docs/product-surfaces.md`.** The Desktop section currently mentions only Browser/PTY
  distinctions (`docs/product-surfaces.md:69-72`); add this desktop-only shell capability. The file
  says a stale surface map is unfinished work (`docs/product-surfaces.md:1-5`).
- **Update `docs/system-architecture.md`.** Add the state file location/schema, normal-bounds rule,
  current-display validation/fallback, and failure-soft persistence beside the existing desktop
  `userData` persistence section (`docs/system-architecture.md:929-957`).
- **Do not edit `CHANGELOG.md` directly.** The release workflow consumes changesets into the
  version PR, then stable desktop assets publish the draft release
  (`AGENTS.md:253-258`; `.github/workflows/release.yml:37-55,71-78`).
- **No AGENTS/ADR change required** unless implementation changes desktop architecture or a locked
  decision; this feature stays within ADR-010's existing Electron thin-shell model
  (`docs/architecture-decisions.md:117-125`).

Important existing gate gap: `scripts/changeset-utils.mjs:5-21` does not classify
`apps/desktop/src/**` as user-facing, so `bun run check-changeset` may pass without a fragment.
Repository policy still makes the patch changeset mandatory (`AGENTS.md:29-35,219-240`); do not use
the CI blind spot as an exemption. Fixing that generic gate is a reasonable separate follow-up, not
required for the window-state implementation.

## Unresolved questions

None.
