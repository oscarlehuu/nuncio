# Desktop window-state review

Verdict: **CHANGES REQUESTED**. One confirmed P2 lifecycle blocker. No other actionable findings in the reviewed diff.

## Finding

### [P2][CONFIRMED] Quit while minimized loses the prior maximized state

- Evidence: `apps/desktop/src/window-state.js:107-115` recomputes `maximized` from `win.isMaximized()` on every flush. `apps/desktop/src/main.js:1204-1209` forces that flush at quit. Electron 42.5.2 explicitly reports `isMaximized() === false` after a maximized window is minimized, while `restore()` later returns that same live window to maximized state ([pinned upstream spec](https://github.com/electron/electron/blob/v42.5.2/spec/api-browser-window-spec.ts#L2141-L2156)).
- Impact: maximize -> minimize -> Cmd+Q/Quit writes `{ maximized: false }`; next launch opens normal instead of restoring the pre-minimize maximized state. This violates the intended rule that minimized state is not restored but the underlying maximized state is preserved.
- Reproduction against current manager: maximize persistence writes `true`; set the fake to Electron's minimized semantics (`isMaximized() => false`); `manager.flush()` writes `false` for the same normal bounds.
- Fix: cache the last non-minimized maximized state (updated by maximize/unmaximize, with current state used outside minimize) and persist that cached value while minimized. Add a regression covering maximize -> minimize -> close/before-quit -> reload. Current lifecycle test at `apps/desktop/test/window-state.test.js:133-212` has no minimize state, so all green tests miss the defect.

## Verification

- Focused window-state/main tests: 32 pass, 0 fail.
- Full desktop suite: 88 pass, 0 fail.
- Desktop lint: exit 0; three pre-existing warnings.
- `git diff --check`: clean.

## Re-review after P2 fix

Verdict: **APPROVED**. The confirmed P2 is resolved; no new actionable findings.

- `[RESOLVED][CONFIRMED]` `apps/desktop/src/window-state.js:100-126` now caches the last non-minimized maximized state and does not replace it with Electron's temporary `false` while minimized. The regression at `apps/desktop/test/window-state.test.js:193-207` proves maximize -> minimize -> close persists `maximized: true`.
- Minimize/restore listeners at `apps/desktop/src/window-state.js:147-155` create no lifecycle issue. Minimize flushes only after the native window reports minimized, so it preserves the cache. Restore flushes after minimization ends and refreshes from the actual restored state; Electron's pinned lifecycle restores a minimized-maximized window to `isMaximized() === true`. Pending debounce cancellation, close flush ordering, and listener disposal remain shared and correct.
- Focused verification: `bun test apps/desktop/test/window-state.test.js` -> 9 pass, 0 fail, 28 assertions. A direct event-sequence probe also produced `true` for maximize, minimize, close, and restore writes.

## Unresolved questions

None.
