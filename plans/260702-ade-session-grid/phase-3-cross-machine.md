# Phase 3 — Cross-Machine Tiles

**Goal:** One grid mixes sessions from multiple tailnet machines through hub mode. The empty-slot composer grows a machine picker; each tile talks to its own machine's base path.

## Scope

- **Per-tile API base:** today the machine switcher swaps the whole app onto one hub base path. Introduce a per-slot machine binding: slot state becomes `{ machineId?, sessionId? }`, and every API/stream call inside a tile resolves its base path from the slot, not the global switcher. The global switcher remains for the single-session view and the sidebar.
- **Composer machine picker:** empty slot gains a machine dropdown (from hub discovery); project picker and session creation then target that machine.
- **Sidebar scope:** decide rendering for the left sidebar in mixed grids — group sessions by machine (recommended) vs. current-machine-only. Group-by-machine keeps the "which agent needs me" overview true while maximized.
- **Resilience:** a machine going unreachable degrades its tiles to a reconnect state (not an empty slot); hub SSRF guard and auth semantics unchanged.

## Out of scope

- Hub discovery/auth changes; any server work beyond what per-tile base paths strictly require (expected: none — hub path routing already exists).
- Cross-machine session *migration* (moving a session between machines).

## Acceptance

- 2×2 grid with tiles on two machines: both stream live simultaneously; steer works on each; borders reflect each session's true state.
- Creating a session on machine B from an empty slot while machine A tiles keep streaming.
- Killing machine B's daemon: its tiles show reconnecting, machine A tiles unaffected; B recovers via `since=` cursor with no gaps.
- Layout restore rebinds `{ machineId, sessionId }` pairs; an unknown machine degrades to an empty slot with a notice.

## Risks

- Hidden global-base assumptions in `packages/core`/`lib` fetch helpers — audit for module-level base-path state before threading per-tile bases.
- Connection budget doubles per machine on HTTP/1.1 SSE — this phase strongly prefers landing after `260701` Phase B2 (WS multiplex per machine).

## Outcome (shipped 2026-07-02)

Slots carry `{ sessionId, machineId? }`; remote tiles own their data path against the
machine's origin-absolute base (`/m/<name>` URLs bypass the page-level fetch rewrite, so no
global base state had to move). The composer's machine picker threads that base through the
project picker, folder browser, and model catalog, and creates/attaches directly against the
chosen machine. One deliberate deviation: a remote tile maximizes by navigating to the
session on the machine's own base path instead of mounting SessionDetail in place — the
inspector panels (SCM, terminal, files, browser) are deeply page-base-relative, and the
machine switcher's plain-anchor philosophy already established "another machine = its own
page". The left sidebar was left unchanged (it lists the current machine's sessions; the
machine switcher remains the cross-machine overview) — grouping-by-machine can come later
if mixed grids make it feel necessary.
