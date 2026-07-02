# ADE Session Grid — Multi-Session Workspace

**Status:** Planning · rides on `260701-desktop-daemon-mobile` (Phase A desktop shell, Phase B WS relay)
**Thesis:** Turn the single-session viewer into an agent workbench: a grid of *slots* where each slot is either an empty new-session composer or a live session tile. The screen answers "which agent needs me?" at a glance (status borders), and any tile maximizes into a full session view with a dedicated right-sidebar inspector. Desktop ships first (inside the Electron shell); the plain web client gets the same code after.

## Decisions (locked — founder, 2026-07-02)

| Decision | Choice | Why |
|----------|--------|-----|
| Layout model | **Grid presets** (1×1, 2×1, 2×2, 3×2), not a tiling tree | Covers real usage (uniform tiles); ~4× cheaper than a recursive split tree. Tree can come later if ever needed. |
| Tile unit | **Slot**, not session | An empty slot renders a new-session composer (machine · project · provider/model · prompt); on submit the slot becomes the live tile for the created session. A slot can also attach an existing session. The grid is a workbench, not a viewer. |
| Maximize behavior | **Hide other tiles entirely** | No mini-strip; the left sidebar session list (with status dots) remains the overview while maximized. |
| Right sidebar on maximize | **Inspector dock** with vertical tabs: Files · Diff/PR · Terminal · Browser · Context | Consolidates the panels that already exist (`file-explorer-panel`, `pr-panel`, `terminal-dock`, `browser-panel`, `review-changes`, `context-usage`) into one dock instead of ad-hoc placements. |
| Cross-machine tiles | **Yes — one grid mixes sessions from multiple hub machines** | Nuncio's edge over folder-scoped tools: manage every project on the tailnet in one view. Requires per-tile API base path (today the machine switcher is app-global), so it lands as its own phase after the grid core. |
| Surface order | **Desktop (Electron shell) first, web after** | Same `apps/web` codebase; grid is developed desktop-viewport-first and shipped in the shell. Browser/hub surface inherits it once stable. Expo mobile keeps the single-session view. |
| Tile rendering | **Level-of-detail (LOD)** | Small tiles render a tail only (status, session/project name, model + context %, last ~30 transcript blocks from a ring buffer). Full `SessionDetail` (composer, scroll, virtualization) mounts only on the focused/maximized tile. |
| Focus border | **Border is a state channel, not just a cursor** | Bright = focused (keyboard target). Amber pulse = pending user input (from `derive-pending-user-input`). Green = running. Gray = idle/done. |
| Layout persistence | **localStorage per device** (phase 1) | Layout is tied to screen size; syncing it across devices has no value yet. Server-side sync only if multi-desktop usage appears. |

## Constraints

- Do not fork the session UI: the maximized tile IS `SessionDetail`, the small tile is a new lightweight `SessionTile` sharing the same event-log data layer.
- SSE connection budget: N tiles = N `EventSource`s; HTTP/1.1 caps ~6 connections per origin, which a 3×2 grid alone exhausts. Phase 1 mitigation: serve over HTTP/2 locally or cap live tiles; the real fix is Phase B's multiplexed WS relay (`subscribe(sessionId, since)` on one socket) — the grid should adopt it as soon as B2 lands.
- Existing single-session route `/session/:id` keeps working (deep links, mobile).

## Phases

| Phase | Focus | Plan |
|-------|-------|------|
| 1 | Grid shell: presets, slot model, empty-slot composer, LOD tiles, status/focus borders, maximize | [phase-1-grid-shell.md](./phase-1-grid-shell.md) |
| 2 | Inspector dock (right sidebar on maximize), keyboard shortcuts, layout persistence | [phase-2-inspector-dock.md](./phase-2-inspector-dock.md) |
| 3 | Cross-machine tiles: per-tile hub base path, mixed-machine grid | [phase-3-cross-machine.md](./phase-3-cross-machine.md) |

Ordering rule: Phase 1 is 80% of the felt value (the BridgeMind feel). Phase 2 is consolidation, no new data paths. Phase 3 touches the hub client contract — keep it isolated so grid core never blocks on hub work.

## What already exists (do not rebuild)

- Event log + cursor replay (`GET :id/events?since=`, `GET :id/stream?since=`) — LOD tail is a thin consumer of this.
- `use-session-stream` reconnect/dedupe client — reuse for tiles, parameterized by buffer depth.
- `derive-pending-user-input` — drives the amber border.
- Session FSM statuses — drive green/gray borders.
- Hub mode base-path routing + machine switcher (app-global today) — Phase 3 makes the base path per-tile.
- All inspector panels — Phase 2 only re-homes them.
