# Desktop window-state verification

Date: 2026-07-17
Scope: automated desktop helper/lifecycle verification; read-only implementation review

## Outcome

Focused specs, full desktop package tests, and desktop lint pass. No reproduced implementation defect. Persistence, malformed input, removed-monitor fitting, maximized launch restoration, close-to-tray flush, and first-phase `before-quit` flush all have automated proof.

## Commands and results

1. `bun test apps/desktop/test/window-state.test.js apps/desktop/test/main-dev-mode.test.js`
   - Exit 0.
   - 32 pass, 0 fail, 146 assertions, 2 files.
2. `bun test --coverage apps/desktop/test/window-state.test.js apps/desktop/test/main-dev-mode.test.js`
   - Exit 0.
   - 32 pass, 0 fail.
   - `apps/desktop/src/window-state.js`: 100% functions, 99.19% lines.
   - `main.js` is executed through `vm.runInNewContext`, so Bun's table does not instrument/report it; wiring confidence comes from harness assertions, not a line percentage.
3. `bun run --filter @nuncio/desktop test`
   - Exit 0.
   - 88 pass, 0 fail, 292 assertions, 9 files.
4. `bun run --filter @nuncio/desktop lint`
   - Exit 0.
   - Three non-blocking warnings, all outside changed window-state logic: `design-mode.js:87` unnecessary escape, `main-dev-mode.test.js:74` thenable test double, `main.js:980` unnecessary spread.

## Coverage audit

| Scenario | Evidence | Assessment |
|---|---|---|
| Persistence | `window-state.test.js:52-79` round-trip + non-fatal write failure; `:134-206` debounced writes and forced flush | Covered |
| Invalid/corrupt state | `window-state.test.js:15-50` missing, bad JSON, wrong shapes, non-finite/zero dimensions, strict boolean, negative coordinates | Covered at helper boundary |
| Removed monitor | `window-state.test.js:92-112` fitting; `main-dev-mode.test.js:471-497` constructor rehoming | Covered in helper + lifecycle harness |
| Maximized restoration | `main-dev-mode.test.js:441-469` restores normal rectangle then calls `maximize()` once; helper records normal bounds with current maximized flag | Covered |
| Close-to-tray | `main-dev-mode.test.js:804-852` preserves hide/daemon behavior and synchronously flushes latest pending normal bounds | Covered |
| Before quit | `main-dev-mode.test.js:948-976` flushes pending bounds before asynchronous supervisor shutdown; `main.js:1204-1224` ordering inspected | Covered for first phase |

Static wiring matches intent: state path resolves under Electron `userData`; bounds are restored before `BrowserWindow` construction; manager listeners attach before startup maximization and before close-to-tray listener; persistence uses `getNormalBounds()`; `before-quit` flush happens before asynchronous daemon stop.

## Gaps and severity

Blockers: none from executed scope.

Observations:

1. Two-phase quit completion is not asserted. Current test proves first `before-quit` prevents and flushes, but does not await supervisor stop, simulate the second `before-quit`, and prove it is allowed through. The implementation's `quittingAfterDaemonStop` guard looks correct; this is a concrete regression-test gap explicitly listed in the plan.
2. Destroy/activate recreation is not exercised truthfully. Existing activate test truncates `state.windows`; it never emits `closed`, checks manager disposal/pending-timer cancellation, or proves the recreated window owns a fresh manager and restored state. Implementation cleanup looks correct by inspection; test gap only.
3. Corrupt/unavailable fallback is proven in the helper, not through `createWindow()`. A harness case asserting default `1280x900`, non-maximized startup from corrupt state would close that lifecycle seam.
4. No live Electron quit/relaunch evidence was produced in this tester subtask. Automated proof cannot verify native macOS placement/maximize behavior end to end.

## Unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** Desktop window-state implementation passes focused, coverage, full desktop, and lint checks; no defect reproduced.
**Concerns/Blockers:** No blocker. Missing two-phase quit, real closed-to-activate recreation, main-wiring corrupt fallback, and live Electron relaunch proof.

## Final verification addendum: minimized-from-maximized review fix

Post-review commands:

1. `bun test apps/desktop/test/window-state.test.js apps/desktop/test/main-dev-mode.test.js`
   - Exit 0.
   - 32 pass, 0 fail, 147 assertions, 2 files.
2. `bun run --filter @nuncio/desktop test`
   - Exit 0.
   - 88 pass, 0 fail, 293 assertions, 9 files.

Regression inspection:

- `window-state.js:100-126` caches the last maximized value observed while the window is not minimized. When Electron reports `isMaximized() === false` during minimization, persistence deliberately keeps that cache.
- `window-state.js:147-154` flushes on maximize, unmaximize, minimize, restore, and close, so close-to-tray and `before-quit` reuse the corrected state.
- `window-state.test.js:193-220` models the reported Electron sequence: maximize writes `true`; minimize makes `isMaximized()` false; both minimize and close still write `maximized: true`; a later real unmaximize writes `false` with the new normal bounds.
- The targeted test asserts the manager output rather than physically relaunching Electron. Existing save/load round-trip and launch-restoration tests cover the downstream file/relaunch halves, so the composed automated proof directly covers the original failure without a new blocker.

Verdict: confirmed P2 fixed. No new defect found. Earlier non-blocking coverage observations remain unchanged. No implementation files edited by tester.

## Addendum unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** Minimized-from-maximized regression fix verified; focused and full desktop suites green.
**Concerns/Blockers:** Review blocker resolved. Only previously documented non-blocking lifecycle/live-Electron coverage gaps remain.
