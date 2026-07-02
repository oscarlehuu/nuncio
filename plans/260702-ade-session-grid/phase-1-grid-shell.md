# Phase 1 — Grid Shell

**Goal:** Replace "one session per screen" with a grid of slots on desktop viewports. Empty slot = new-session composer; filled slot = live LOD tile; any tile maximizes in place. The screen answers "which agent needs me?" via status borders.

## Scope

- **Grid state model:** `{ preset: '1x1' | '2x1' | '2x2' | '3x2', slots: Array<{ sessionId?: string }> }`, persisted to localStorage per device. New route (e.g. `/grid`) or make it the desktop home view; `/session/:id` untouched.
- **Empty slot composer:** compact form — project picker, provider/model picker, prompt box (reuse existing pickers). Submit → `createSession` → slot binds to the new session id and flips to a live tile. An "attach existing session" affordance (dropdown of recent/idle sessions) fills a slot without creating.
- **`SessionTile` (LOD):** status dot, session name, project, model + context %, tail of last ~30 transcript blocks via a ring buffer on the existing event stream. No composer, no full scroll history. Click = focus; header double-click or button = maximize.
- **Focus + status borders:** one focus at a time (click to move). Border color/animation from session state: bright = focused, amber pulse = pending user input, green = running, gray = idle/done. Focused tile gets the steer composer.
- **Maximize:** the slot's session mounts full `SessionDetail` filling the main area; other tiles unmount (hidden entirely — left sidebar remains the overview). Un-maximize restores the grid with ring buffers intact.
- **Connection budget:** cap concurrent live tiles at the preset size; document the HTTP/1.1 six-connection limit and verify the dev/desktop serving path (Electron → local daemon) runs HTTP/2 or stays under budget. Adopt the WS multiplex from `260701` Phase B2 when it lands.

## Out of scope

- Right sidebar inspector, keyboard shortcuts, layout sync (Phase 2).
- Cross-machine tiles (Phase 3).
- Tiling tree, drag-to-rearrange between slots (later, if ever).
- Any mobile/Expo surface — single-session view stays.

## Acceptance

- 2×2 grid: create two sessions from empty slots, attach one existing session — three live tiles stream concurrently, tails stay in sync with the event log.
- A session hitting "needs input" pulses amber without being focused; clicking it focuses and shows the composer.
- Maximize → full transcript with scrollback (replayed via `since=` cursor), un-maximize → grid restored, no stream gaps.
- Reload restores the same preset + slot bindings (localStorage), dead session ids degrade to empty slots.
- `/session/:id` deep links still render the classic single view.

## Risks

- N concurrent `EventSource`s starving other requests on HTTP/1.1 — spike the serving path first.
- Transcript tail rendering cost with 6 active agents streaming — ring buffer must bound both memory and re-renders (throttled reveal already exists; reuse).
