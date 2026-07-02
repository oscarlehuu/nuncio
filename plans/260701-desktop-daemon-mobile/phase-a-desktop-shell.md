# Phase A — Electron Desktop Shell

**Goal:** Double-click app → daemon running → UI open. No terminal, no manual Tailscale for local use. Runs on today's SSE relay (no relay changes yet).

## Scope

- `apps/desktop` — Electron main process (matches Synara's `apps/desktop`).
- Supervise the Bun/Nest daemon as a child process (spawn on app start, health-check, restart on crash, kill on quit).
- Load `apps/web` build into the renderer (packaged assets, not Vite dev) — existing shadcn UI verbatim, no rewrite.
- Tray icon with daemon status (running / stopped / restarting).
- Native folder dialog → replaces server-side folder picker for local use (keep server picker for remote clients).
- Native OS notifications on session state changes (done / needs input / error).
- Begin dropping PWA scaffolding from `apps/web` (service worker, install prompts, manifest); stop mobile-first CSS compromises as desktop layouts are touched. Full removal lands as Expo replaces it (Phase C) — no phone regression to guard since PWA is being retired deliberately.

## Out of scope (later phases)

- WebSocket relay (Phase B).
- `packages/core` extraction (Phase B).
- Any mobile work (Phase C).

## Acceptance

- Fresh machine: install → launch → create a Pi session → stream renders, no terminal touched.
- Quit app → daemon process is gone (no orphan).
- Daemon crash → tray shows restarting → recovers, session stream resumes via existing `since=` cursor.

## Risks

- Bun-as-child-process path resolution when packaged (asar, PATH for `cursor`/git). Spike early.
- Port collision if a `bun dev` is already running — pick/lease a port, surface in tray.
