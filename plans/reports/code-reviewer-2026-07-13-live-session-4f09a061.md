# Code review: live session `4f09a061`

Date: 2026-07-13
Scope: screenshot duplicate-user-message scenario; read-only live DB + current server/core/web diff

## Findings

### P2 — CONFIRMED: bounded initial history can still expose a persisted polluted duplicate

The suppression rule requires the earlier canonical user block to exist in parser state
(`packages/core/src/transcript-build-blocks.ts:399-406`). If it is absent, the code continues and
renders the original polluted `rawText` (`packages/core/src/transcript-build-blocks.ts:408-450`).

The full session view intentionally bootstraps only the last 1,000 events
(`apps/web/src/lib/use-session-stream.ts:10-11`, `:111-116`; wired at
`apps/web/src/App.tsx:950-954`). Therefore a long session with an already-persisted legacy/exact
duplicate inside the loaded tail but its canonical row before the tail boundary will still show the
duplicate and Nuncio browser instructions until the user loads older history.

Empirical replay of the live rows proves the boundary behavior:

- Full 506-event batch and incremental replay: zero polluted user blocks.
- A bounded replay starting at seq 407: seq 439 renders as polluted because canonical seq 2 is absent.
- Prepending the older page repairs projection: incremental prefix validation resets and the full
  replay suppresses seq 439 (`apps/web/src/lib/use-transcript-blocks.ts:65-98`; history prepend at
  `apps/web/src/lib/use-session-stream.ts:150-165`).

Impact: current screenshot session is fixed, but the same symptom remains possible on sessions
longer than the 1,000-event initial window. This is not speculative hardening; it is a deterministic
projection failure for append-only legacy rows whose canonical match is outside the client window.

## Scenario verdict

- **CONFIRMED fixed for `4f09a061`:** live DB has 506 events, so the 1,000-event detail tail includes
  canonical seq 2 and seq 450. The current decoder maps seq 439 exactly to seq 2 and seq 505 exactly
  to seq 450. Both batch and event-by-event incremental replay produce two canonical user blocks and
  zero polluted blocks.
- **CONFIRMED future import prevention:** Pi hydration decodes before occurrence-count dedupe
  (`apps/server/src/pi-local/pi-transcript-hydrate.ts:29-36`;
  `apps/server/src/sessions/sessions.service.ts:1910-1952`), so a refreshed legacy Pi transcript no
  longer appends these duplicates. Existing SQLite events remain append-only, as required.
- **CONFIRMED checkpoint correctness with full history:** decoded duplicates return before assistant
  flush (`packages/core/src/transcript-build-blocks.ts:394-409`), so seq 439/505 cannot move after the
  final assistant response. Normal incremental extension retains the canonical blocks in checkpoint
  state; prepended paging invalidates the checkpoint and rebuilds correctly.

## Unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** The exact live screenshot scenario is fixed in server dedupe, batch projection, and incremental projection. One deterministic P2 remains for persisted duplicates whose canonical row falls outside the 1,000-event initial window.
**Concerns/Blockers:** Bounded-window projection needs an implementation decision; no implementation file was edited.
