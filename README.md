# Nuncio

A self-hosted, Devin-like web app for delegating tasks to AI agents — built for daily use, especially on mobile.

## Status

Phase 0–3 · agent-provider abstraction + Pi auth hardening.

## Quick start

```bash
npm install
npm run dev
```

- **API:** http://localhost:3000/api/health
- **Web:** http://localhost:5173 (proxies `/api` → 3000)

```bash
npm run build   # build server + web
npm test        # server unit tests
npm run test:e2e -w apps/server        # HTTP e2e tests (mock provider)
npm run test:integration -w apps/server # real Pi auth (skips when ~/.pi/agent absent)
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

- **Agent providers:** Pi SDK + Mock behind a common `AgentProvider` interface; `AgentRegistry` selects per session. Pi auth via the SDK's `AuthStorage` (API key **or** OAuth/subscription) at `~/.pi/agent` (override: `PI_CODING_AGENT_DIR`). Falls back to Mock when Pi has no configured credentials. See [docs/system-architecture.md](docs/system-architecture.md).
- **Backend:** NestJS (`apps/server`) on port 3000
- **Frontend:** Vite + React + Tailwind (`apps/web`) on port 5173
- **Persistence:** SQLite (`better-sqlite3`) in `data/nuncio.db` — sessions (with `provider` + `model`) + event log
- **Auth:** Tailscale (network) + static app token (planned)
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions (`?includeArchived=1`) |
| POST | `/api/sessions` | Create session `{ "prompt": "...", "provider?": "pi\|mock", "model?": "..." }` |
| GET | `/api/sessions/:id` | Session detail (incl. `provider`, `model`) |
| GET | `/api/sessions/:id/events?since=` | Event log (cursor) |
| GET | `/api/sessions/:id/stream?since=` | SSE stream |
| POST | `/api/sessions/:id/steer` | Steer agent `{ "message": "..." }` |
| POST | `/api/sessions/:id/pause` | Pause session |
| POST | `/api/sessions/:id/archive` | Archive session |
| GET | `/api/models` | Model catalog (aggregated from available providers) |

### Session FSM

`CREATED` → `RUNNING` → `IDLE` | `ERROR` | `PAUSED`  
`IDLE`/`PAUSED` → `RUNNING` (steer) · `IDLE`/`PAUSED`/`ERROR` → `ARCHIVED`

## Project layout

```
apps/
  server/
    src/
      agents/        AgentProvider interface + BaseAgentProvider + AgentRegistry + providers/ (pi, mock)
      sessions/      api/ · domain/ (types, fsm) · persistence/ (repositories) + service + module
      models/        model catalog aggregation from providers
      health/ · db/
    test/
      unit/          *.spec.ts (jest, CJS)
      e2e/           HTTP e2e (mock provider)
      integration/   real Pi auth (skips when ~/.pi/agent absent; --experimental-vm-modules)
  web/      Vite React UI
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
docs/       system-architecture.md
```

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable) / Machine state (FSM)
- **Provider-neutral agent layer:** every agent SDK implements `AgentProvider`; `AgentRegistry` resolves per session so Pi/Cursor/any future SDK plug in uniformly
- **Per-session provider + model selection** — `provider` + `model` stored on the session, wired through to the SDK
- **Long-running, resumable sessions** — FSM + event log persist in SQLite; Pi conversation history is in-memory pending session revival (planned)

## License

MIT
