# Nuncio

A self-hosted, Devin-like web app for delegating tasks to AI agents — built for daily use, especially on mobile.

## Status

Phase 0–1 vertical slice · Phase 2 PWA/mobile · Phase 3 steer + model picker.

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

## PWA install (iPhone)

Nuncio ships as an installable PWA (`vite-plugin-pwa`: manifest, service worker, standalone display). **Add to Home Screen on iPhone requires HTTPS** — Safari will not offer a full install from plain `http://` localhost.

1. Deploy with Tailscale HTTPS (see [Production deploy](#production-deploy-tailscale) below).
2. On your iPhone, open the Tailscale URL in **Safari** (not an in-app browser).
3. Tap **Share** → **Add to Home Screen**.
4. Launch Nuncio from the home-screen icon — it runs in standalone mode with the dark theme and app icon.

The service worker precaches the UI shell; `/api/*` uses network-first so session data stays fresh.

## Production deploy (Tailscale)

Build and run the production stack on your machine, then expose it over Tailscale for HTTPS access from your phone or other devices on your tailnet.

```bash
npm run build
npm run start:prod -w apps/server   # API on :3000
npm run preview -w apps/web         # built UI on :5173 (proxies /api → 3000)
tailscale serve --bg 5173
```

Open `https://<your-machine>.<tailnet>.ts.net` — Tailscale terminates TLS so iPhone PWA install works.

**API on port 3000:** In dev, Vite proxies `/api` to the NestJS server. The same proxy applies when using `vite preview`, so a single `tailscale serve --bg 5173` is usually enough — the browser only talks to 5173 and the preview server forwards API calls to localhost:3000.

If you serve the API and web separately (e.g. static files from another host without a proxy), you may need a **second** `tailscale serve` for port 3000, or a **unified reverse proxy** (nginx, Caddy, etc.) that routes `/` → web and `/api` → server under one HTTPS origin.

## Roadmap

Phase plans and milestones: [plans/260626-nuncio-roadmap/](plans/260626-nuncio-roadmap/)

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
| POST | `/api/sessions/:id/steer` | Steer agent `{ "message": "..." }` |
| POST | `/api/sessions/:id/pause` | Pause session |
| POST | `/api/sessions/:id/archive` | Archive session |
| GET | `/api/models` | Model catalog (Pi registry or static fallback) |

### Session FSM

`CREATED` → `RUNNING` → `IDLE` | `ERROR` | `PAUSED`  
`IDLE`/`PAUSED` → `RUNNING` (steer) · `IDLE`/`PAUSED`/`ERROR` → `ARCHIVED`

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
