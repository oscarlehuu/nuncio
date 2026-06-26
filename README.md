# Nuncio

A self-hosted, Devin-like web app for delegating tasks to AI agents — built for daily use, especially on mobile.

## Status

Phase 0–1 vertical slice: monorepo scaffold, session API, SSE streaming, and mockup-inspired UI.

## Quick start

```bash
npm install
npm run dev
```

- **API:** http://localhost:3000/api/health
- **Web:** http://localhost:5173 (proxies `/api` → 3000)

```bash
npm run build   # build server + web
npm test        # server unit/integration tests
```

## Architecture

- **Agent harness:** [Pi SDK](https://github.com/earendil-works/pi) (`createAgentSession`) — in-process, resumable; falls back to mock agent when `~/.pi/agent/auth.json` is missing
- **Backend:** NestJS (`apps/server`) on port 3000
- **Frontend:** Vite + React + Tailwind (`apps/web`) on port 5173
- **Persistence:** SQLite (`better-sqlite3`) in `data/nuncio.db` for sessions + event log
- **Auth:** Tailscale (network) + static app token (planned)
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## API (Phase 1)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session `{ "prompt": "..." }` |
| GET | `/api/sessions/:id` | Session detail |
| GET | `/api/sessions/:id/events?since=` | Event log (cursor) |
| GET | `/api/sessions/:id/stream?since=` | SSE stream |

### Session FSM

`CREATED` → `RUNNING` → `IDLE` | `ERROR` (steer resumes `IDLE` → `RUNNING`)

## Project layout

```
apps/
  server/   NestJS API + Pi harness
  web/      Vite React UI
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
```

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable) / Machine state (FSM)
- **Long-running, resumable sessions** — lazy-revive FSM
- **Per-session model selection** — Provider → Group → Model (planned)

## License

MIT
