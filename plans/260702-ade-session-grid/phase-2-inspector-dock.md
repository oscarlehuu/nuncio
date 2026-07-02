# Phase 2 — Inspector Dock + Ergonomics

**Goal:** When a tile is maximized, a dedicated right sidebar carries everything about that session that isn't the transcript. Keyboard makes the grid fast.

## Scope

- **Inspector dock:** right sidebar on the maximized view with vertical tabs: Files · Diff/PR · Terminal · Browser · Context. Re-home the existing panels (`file-explorer-panel`, `pr-panel` + `review-changes`, `terminal-dock`, `browser-panel`, `context-usage`) — move, don't rewrite. Collapsible; remembers last-open tab per device.
- **Keyboard shortcuts:** `Cmd+1..9` focus slot N, `Cmd+Enter` maximize/restore focused tile, `Esc` un-maximize. Registered only on the grid surface; no collisions with composer editing.
- **Layout persistence polish:** preset + slot bindings + dock state in one localStorage key with a versioned shape (migration-safe).

## Out of scope

- New panel types; server changes; cross-machine (Phase 3).
- Server-side layout sync (only if multi-desktop usage appears).

## Acceptance

- Maximized session shows the dock; every tab renders the same panel behavior it had before the move (existing panel specs still pass).
- Browser dock rule preserved: Browser tab appears only on the desktop (Electron) surface, hidden on plain web.
- `Cmd+3` focuses slot 3; `Cmd+Enter` toggles maximize; `Esc` restores the grid; none of these fire while typing in a composer or terminal.
- Reload restores preset, bindings, and last-open dock tab.

## Risks

- Panel components may assume the old mount context (widths, containers) — verify each in the dock at realistic sidebar widths in a real browser (per memory: jsdom misses layout/Radix bugs).

## Outcome (shipped 2026-07-02)

The dock already existed inside `SessionDetail` (SCM/Files/Terminal/Browser tab rail), so
this phase reduced to: wiring the orphaned `PrPanel` into the SCM tab, persisting the dock's
open state + last tab (new `inspector-preference` localStorage key — kept separate from
`grid-preference` because the dock lives in `SessionDetail`, so `/session/:id` benefits too),
and the grid keyboard shortcuts. The Context tab was not moved into the dock — the context
usage button already sits in the composer and re-homing it added nothing.
