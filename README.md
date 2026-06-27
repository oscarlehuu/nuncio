# Nuncio

A self-hosted, mobile-first web app for delegating tasks to AI coding agents. Run it on your own machine, point it at your own Pi / Anthropic / OpenAI credentials, and assign work from your phone — agents keep going while you're away, and you can steer them mid-task.

Think Devin, but self-hosted and provider-neutral: the agent layer is a single interface, so Pi runs today and any future agent SDK (Cursor, …) can plug in uniformly.

## Features

- **Delegate tasks** — create a session with a prompt; the agent runs in-process and streams output as events
- **Per-session provider + model** — choose the agent provider (`pi` / `mock`) and the exact model (e.g. `openai-codex:gpt-5.5`, `anthropic:claude-sonnet-4`) per session; both are stored on the session and wired through to the SDK
- **Steer mid-task** — send follow-up messages that continue the same agent conversation (the Pi session handle is retained)
- **Pause / archive** — suspend a running session or retire it; a session FSM enforces valid transitions
- **Real-time + replay** — SSE stream for live updates, event log with cursor for replay
- **Mobile-first PWA** — installable on iPhone via Tailscale HTTPS; standalone dark UI, safe-area aware
- **Self-hosted** — your machine, your SQLite, your credentials; nothing leaves your tailnet
- **Provider-neutral agent layer** — `AgentProvider` interface + `AgentRegistry`; Pi and Mock today, extensible

## Status

Phase 0–3 complete (vertical slice · PWA/mobile · steer + model picker) with agent-provider abstraction and Pi auth hardening. Phase 4 (git workspace / branch / PR) and Phase 5 (web push / webhooks) planned — see [Roadmap](#roadmap).

## Quick start

```bash
npm install
npm run dev
```

- **API:** http://localhost:3000/api/health
- **Web:** http://localhost:5173 (proxies `/api` → 3000)

```bash
npm run build   # build server + web
```

### Pi credentials

Nuncio drives the [Pi SDK](https://github.com/earendil-works/pi) in-process. Log in with the `pi` CLI first so `~/.pi/agent/auth.json` exists — it holds your API key **or** OAuth/subscription tokens (OpenAI, Anthropic). Override the agent directory with `PI_CODING_AGENT_DIR`. When no Pi credentials are configured, Nuncio falls back to a built-in **Mock** provider so the UI still works end-to-end.

## Testing

```bash
npm test                                  # server unit tests (mock provider)
npm run test:e2e -w apps/server           # HTTP e2e (mock provider)
npm run test:integration -w apps/server   # real Pi auth — skips when ~/.pi/agent absent
npm test -w apps/web                      # web component tests (vitest)
```

The integration suite runs jest with `--experimental-vm-modules` because the Pi SDK is ESM and jest's CJS runner needs that flag for dynamic `import()`. It skips automatically on machines without Pi auth, so it is CI-safe.

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

## PWA install (iPhone)

Nuncio ships as an installable PWA (`vite-plugin-pwa`: manifest, service worker, standalone display). **Add to Home Screen on iPhone requires HTTPS** — Safari will not offer a full install from plain `http://` localhost.

1. Deploy with Tailscale HTTPS (see [Production deploy](#production-deploy-tailscale) above).
2. On your iPhone, open the Tailscale URL in **Safari** (not an in-app browser).
3. Tap **Share** → **Add to Home Screen**.
4. Launch Nuncio from the home-screen icon — it runs in standalone mode with the dark theme and app icon.

The service worker precaches the UI shell; `/api/*` uses network-first so session data stays fresh.

## Architecture

- **Agent providers:** Pi SDK + Mock behind a common `AgentProvider` interface; `AgentRegistry` selects per session. Pi auth via the SDK's `AuthStorage` (API key **or** OAuth/subscription) at `~/.pi/agent` (override: `PI_CODING_AGENT_DIR`). Falls back to Mock when Pi has no configured credentials. See [docs/system-architecture.md](docs/system-architecture.md).
- **Backend:** NestJS (`apps/server`) on port 3000
- **Frontend:** Vite + React + Tailwind + shadcn/ui (`apps/web`) on port 5173
- **Persistence:** SQLite (`better-sqlite3`) in `data/nuncio.db` — sessions (with `provider` + `model`) + append-only event log
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
  web/      Vite React UI (shadcn/ui)
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
docs/       system-architecture.md
```

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable) / Machine state (FSM)
- **Provider-neutral agent layer:** every agent SDK implements `AgentProvider`; `AgentRegistry` resolves per session so Pi/Cursor/any future SDK plug in uniformly
- **Per-session provider + model selection** — `provider` + `model` stored on the session, wired through to the SDK
- **Long-running, resumable sessions** — FSM + event log persist in SQLite; Pi conversation history is in-memory pending session revival (planned)

## Roadmap

Phase plans and milestones: [plans/260626-nuncio-roadmap/](plans/260626-nuncio-roadmap/)

| Phase | Focus | Status |
|-------|-------|--------|
| 0–1 | Vertical slice (sessions, events, SSE, Pi harness) | Done |
| 2 | PWA + mobile + Tailscale prod | Done |
| 3 | Steer, pause, model picker | Done |
| — | Agent-provider abstraction + Pi auth hardening | Done |
| 4 | Git workspace, branch, PR | Planned |
| 5 | Web Push + webhooks | Planned |

## License

MIT
