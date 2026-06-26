# Nuncio

A self-hosted, Devin-like web app for delegating tasks to AI agents — built for daily use, especially on mobile.

## Status

Early design phase. `mockup.html` is the interactive UI blueprint that the implementation will be built from.

## Architecture (planned)

- **Agent harness:** [Pi SDK](https://github.com/earendil-works/pi) (`createAgentSession`) — in-process, resumable
- **Backend:** NestJS on Node 24
- **Frontend:** Vite + React + Tailwind + PWA (mobile-first, installable)
- **Persistence:** SQLite (`better-sqlite3`) for app metadata + Pi native session files for transcripts
- **Auth:** Tailscale (network) + static app token
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable, in-process) / Machine state (independent lifecycle)
- **Long-running, resumable sessions** — lazy-revive FSM (CREATED → RUNNING → IDLE → PAUSED → ERROR)
- **Git integration as MVP** — clone, branch (`nuncio/<id>-<slug>`), commit, PR via `gh`
- **Per-session model selection** — Provider → Group → Model (Cursor Cloud pattern)

## License

MIT
