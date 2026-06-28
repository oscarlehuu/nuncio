# Nuncio

[![CI](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml)
[![Release](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-f9f1e1?logo=bun)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A self-hosted, mobile-first web app for delegating tasks to AI coding agents. Run it on your own machine, point it at your own Pi / Anthropic / OpenAI credentials, and assign work from your phone — agents keep going while you're away, and you can steer them mid-task.

Think Devin, but self-hosted and provider-neutral: the agent layer is a single interface, so Pi runs today and any future agent SDK (Cursor, …) can plug in uniformly.

## Features

- **Delegate tasks** — create a session with a prompt; the agent runs in-process and streams output as events
- **Per-session provider + model** — choose the agent provider (`pi` / `cursor`) and the exact model (e.g. `cursor:composer-2`, `anthropic:claude-sonnet-4`) per session; both are stored on the session and wired through to the SDK
- **Steer mid-task** — send follow-up messages that continue the same agent conversation (the Pi session handle is retained)
- **Pause / archive / restore / delete** — suspend a running session, retire it to the Archived tab, restore it back to IDLE, or permanently delete it; a session FSM enforces valid transitions and a confirm dialog guards deletes
- **Real-time + replay** — SSE stream for live updates, event log with cursor for replay
- **Mobile-first PWA** — installable on iPhone via Tailscale HTTPS; standalone dark UI, safe-area aware
- **Self-hosted** — your machine, your SQLite, your credentials; nothing leaves your tailnet
- **Provider-neutral agent layer** — `AgentProvider` interface + `AgentRegistry`; Pi, Cursor, and Mock today, extensible
- **Settings store** — runtime-configurable env vars (API keys, paths, flags) stored in SQLite and editable via the frontend; secrets encrypted at rest (AES-256-GCM), env vars still honoured as fallback
- **Folder picker** — browse the host machine's directories to pick a project (server-side, works on iPhone PWA), or paste a custom path
- **Continue on mobile** — import an in-progress Cursor IDE/CLI chat from your Mac and steer it from the phone PWA (CLI `--resume` for imported sessions)

## Screenshots

> Screenshots live in [`assets/`](assets/) (added as needed). Until then, the in-app UI matches [`mockup.html`](mockup.html) (the UI blueprint used during development).

## Status

Phase 0–3 complete (vertical slice · PWA/mobile · steer + model picker) with agent-provider abstraction and Pi auth hardening. Phase 4 (git workspace / branch / PR) and Phase 5 (web push / webhooks) planned — see [Roadmap](#roadmap).

## Changelog

Releases are versioned and documented with [Changesets](https://github.com/changesets/changesets) — each pull request ships a hand-written summary fragment, so the changelog reads like curated release notes rather than a commit log.

- **In app:** open the sidebar → ✨ **What's new** (bottom-left) to browse every release, grouped by version and category, with links back to the pull requests that shipped each change.
- **On GitHub:** each release is published as a [GitHub Release](https://github.com/oscarlehuu/nuncio/releases) with the matching changelog section as the body, tagged `v<version>`.
- **In the repo:** [`CHANGELOG.md`](CHANGELOG.md) is the single source of truth.

To add a changelog entry for your PR:

```bash
bun run changeset        # select "nuncio", pick minor/patch, write a release-note-style summary
```

Merging PRs triggers a `chore: release version` PR that bumps the version and updates `CHANGELOG.md`; merging that PR cuts the release (git tag + GitHub Release). See [`.changeset/README.md`](.changeset/README.md) and [AGENTS.md → Releases & changelog](AGENTS.md) for the full workflow.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3 (the server uses `bun:sqlite`, a Bun builtin — Node won't work).

```bash
bun install
bun run dev
```

- **API:** http://localhost:3000/api/health
- **Web:** http://localhost:5173 (proxies `/api` → 3000)

```bash
bun run build   # build server + web
```

### Pi credentials

Nuncio drives the [Pi SDK](https://github.com/earendil-works/pi) in-process. Log in with the `pi` CLI first so `~/.pi/agent/auth.json` exists — it holds your API key **or** OAuth/subscription tokens (OpenAI, Anthropic). Override the agent directory with `PI_CODING_AGENT_DIR`. When no Pi credentials are configured, Nuncio falls back to a built-in **Mock** provider so the UI still works end-to-end.

### Cursor credentials

Set `CURSOR_API_KEY` (from [Cursor dashboard](https://cursor.com/dashboard/cloud-agents)) to enable the **Cursor** provider (`provider: "cursor"`). Uses `@cursor/sdk` local runtime under Bun with `useHttp1ForAgent` + `JsonlLocalAgentStore` escape hatches. Default cwd: `NUNCIO_CURSOR_CWD` or `process.cwd()`. Per-session `workspace` field (Phase 4 UI) overrides cwd when set. The key can also be set via the **Settings** UI (gear icon in the sidebar) — it's stored encrypted at rest and overrides the env var without a restart.

## Testing

```bash
bun run test                                       # server unit tests (simulated cursor provider)
bun run --filter @nuncio/server test:e2e           # HTTP e2e (simulated cursor provider)
bun run --filter @nuncio/server test:integration   # real Pi auth — skips when ~/.pi/agent absent
bun run --filter @nuncio/web test                  # web component tests (vitest)
```

All server tests run on `bun test` (no jest). The integration suite is gated on `~/.pi/agent/auth.json` and self-skips when absent, so it is CI-safe.

## Production deploy (Tailscale)

Build and run the production stack on your machine, then expose it over Tailscale for HTTPS access from your phone or other devices on your tailnet.

```bash
bun run build
bun run --filter @nuncio/server start:prod   # API on :3000
bun run --filter @nuncio/web preview         # built UI on :5173 (proxies /api → 3000)
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
- **Persistence:** SQLite (`bun:sqlite`) in `data/nuncio.db` — sessions (with `provider` + `model`), append-only event log, and a `settings` table for runtime-configurable env overrides (secrets encrypted at rest)
- **Auth:** Tailscale (network) + static app token (planned)
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions (`?includeArchived=1`) |
| POST | `/api/sessions` | Create session `{ "prompt": "...", "provider?": "pi\|cursor", "model?": "..." }` |
| POST | `/api/sessions/handoff` | Import a Cursor IDE/CLI chat `{ "cursorChatId": "...", "workspace": "/abs/path", "title?": "..." }` → `IDLE` session with transcript hydrated |
| GET | `/api/cursor/local-sessions?workspace=` | List in-progress Cursor chats on this Mac for the handoff picker |
| GET | `/api/sessions/:id` | Session detail (incl. `provider`, `model`, `cursorBackend`, `cursorChatId`) |
| GET | `/api/sessions/:id/events?since=` | Event log (cursor) |
| GET | `/api/sessions/:id/stream?since=` | SSE stream |
| POST | `/api/sessions/:id/steer` | Steer agent `{ "message": "...", "forceResume?": true }` — `forceResume` skips the active-run guard for CLI handoff sessions |
| POST | `/api/sessions/:id/pause` | Pause session |
| POST | `/api/sessions/:id/archive` | Archive session (recoverable via `restore`) |
| POST | `/api/sessions/:id/restore` | Restore an archived session → IDLE |
| DELETE | `/api/sessions/:id` | Permanently delete an archived session + its event log |
| GET | `/api/models` | Model catalog (aggregated from available providers) |
| GET | `/api/settings` | List all settings (secrets masked, never raw) |
| PUT | `/api/settings/:key` | Update a setting `{ "value": "..." }` (encrypts secrets, busts provider caches) |
| DELETE | `/api/settings/:key` | Clear a setting (falls back to env/default) |
| GET | `/api/fs/dirs?path=` | Server-side directory browser (defaults to `$HOME`); used by the folder picker |

### Session FSM

`CREATED` → `RUNNING` → `IDLE` | `ERROR` | `PAUSED`
`IDLE`/`PAUSED` → `RUNNING` (steer) · `IDLE`/`PAUSED`/`ERROR` → `ARCHIVED` · `ARCHIVED` → `IDLE` (restore)

Archived sessions are browsable in the sidebar's **Archived** tab (search by title/prompt, restore to IDLE, or delete permanently with a confirm dialog).

### Continue on mobile (Cursor handoff)

Pick **one** in-progress Cursor chat on your Mac and continue it from the Nuncio phone PWA without losing transcript context.

**Setup**

- Install the Cursor CLI (`agent` binary). Default path: `~/.local/bin/agent`.
- Override via env `NUNCIO_CURSOR_AGENT_BIN` or **Settings → NUNCIO_CURSOR_AGENT_BIN** (gear icon in sidebar).
- Set `NUNCIO_PROJECT_ROOTS` (or use **Browse folders…** in the picker) so Nuncio can find chats for your repo.

**Flow**

1. Start or continue a chat in **Cursor IDE** on your Mac (same project folder you pick in Nuncio).
2. On your phone (Tailscale HTTPS PWA), tap **Continue on mobile** (home composer or session header for SDK Cursor sessions).
3. Pick the project folder → select the chat → **Import** (or **Open** if already imported).
4. Steer from the phone; Nuncio runs `agent -p --resume <chatId>` and streams tokens into the session transcript.

**Troubleshooting**

| Symptom | Fix |
|---------|-----|
| Chat not listed | Open the chat in Cursor first; confirm the project folder matches the repo path Cursor uses. Tap **Refresh** in the picker. |
| "Cursor is still running this chat…" (409) | Pause or finish the run in Cursor IDE on your Mac, then retry. |
| "Cursor CLI not found" (503) | Install the CLI or set `NUNCIO_CURSOR_AGENT_BIN` in Settings. |
| "Chat no longer exists" (404) | The transcript folder was removed; start a new chat in Cursor. |
| Steer hangs / no output | Run the server with `bun run --filter @nuncio/server start` (not `dev`) when testing Cursor — `--watch` reloads on DB writes and kills in-flight CLI runs. |

Imported sessions use `cursor_backend=cli` and resume via the CLI subprocess. Sessions you **create** in Nuncio still use `@cursor/sdk` in-process (`cursor_backend=sdk`).

## Project layout

```
apps/
  server/
    src/
      agents/        AgentProvider interface + BaseAgentProvider + AgentRegistry + providers/ (pi, cursor)
      sessions/      api/ · domain/ (types, fsm) · persistence/ (repositories) + service + module
      models/        model catalog aggregation from providers
      health/ · db/
    test/
      unit/          *.spec.ts (bun test)
      e2e/           HTTP e2e (simulated cursor provider)
      integration/   real Pi auth (skips when ~/.pi/agent absent; opt-in)
  web/      Vite + React + Tailwind v4 + shadcn/ui (installable PWA)
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
docs/       system-architecture.md
assets/     Screenshots for the README (un-ignored only here — see .gitignore)
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

## Contributing

Contributions are welcome! Before opening a PR:

- Read [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the TDD-first workflow, the Changeset-based release process, and the PR checklist.
- For context on architecture and conventions, see [AGENTS.md](AGENTS.md) and [docs/system-architecture.md](docs/system-architecture.md).
- Found a security issue? See [SECURITY.md](SECURITY.md) — **do not** open a public issue for vulnerabilities.
- Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — © oscarlehuu. See the [LICENSE](LICENSE) file for the full text.
