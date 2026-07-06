# Nuncio

[![CI](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml)
[![Release](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-f9f1e1?logo=bun)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A self-hosted, mobile-first web app for delegating tasks to AI coding agents. Run it on your own machine, point it at your own Pi / Codex / Cursor credentials, and assign work from your phone — agents keep going while you're away, and you can steer them mid-task.

Think Devin, but self-hosted and provider-neutral: the agent layer is a single interface, so Pi, Codex, Cursor, and future agent SDKs plug in uniformly.

## Features

- **Delegate tasks** — create a session with a prompt; the agent runs in-process and streams output as events
- **Per-session provider + model** — choose the agent provider (`pi` / `codex` / `cursor`) and the exact model (e.g. `codex:gpt-5.5`, `cursor:composer-2`, `anthropic:claude-sonnet-4`) per session; both are stored on the session and wired through to the provider runtime
- **Steer mid-task** — send follow-up messages that continue the same agent conversation when the provider supports it
- **Pause / archive / restore / delete** — suspend a running session, retire it to the Archived tab, restore it back to IDLE, or permanently delete it; a session FSM enforces valid transitions and a confirm dialog guards deletes
- **Real-time + replay** — WebSocket relay (subscribe/steer on one duplex channel, gap-free resume via the event-log cursor — see [docs/ws-relay-contract.md](docs/ws-relay-contract.md)) plus the SSE stream and cursor replay endpoints for API consumers
- **Mobile-first PWA** — installable on iPhone via Tailscale HTTPS; standalone dark UI, safe-area aware
- **Interactive browser dock** — desktop uses a real embedded Electron browser view with a persistent Nuncio profile; the web/PWA surface does not expose a browser dock
- **Self-hosted** — your machine, your SQLite, your credentials; nothing leaves your tailnet
- **Provider-neutral agent layer** — `AgentProvider` interface + `AgentRegistry`; Pi, Codex, Cursor, and Mock today, extensible
- **Settings store** — runtime-configurable env vars (API keys, paths, flags) stored in SQLite and editable via the frontend; secrets encrypted at rest (AES-256-GCM), env vars still honoured as fallback
- **Codex approvals** — switch Codex between full-access and approval-required mode from the composer, then approve or deny pending provider actions in the transcript
- **Folder picker** — browse the host machine's directories to pick a project (server-side, works on iPhone PWA), or paste a custom path
- **Workspace control** — choose a project, run in the local checkout, or create a new `nuncio/<sessionId>-<slug>` worktree forked from the selected branch
- **Continue on mobile** — import an in-progress Cursor IDE/CLI chat or Pi CLI session from your Mac and steer it from the phone PWA (Cursor uses CLI `--resume`; Pi resumes in-process through the SDK)
- **Session grid** — a desktop-first multi-session workbench at `/grid`: lay out sessions in a 1x1/2x1/2x2/3x2 preset, read and scroll each tile's chat transcript with a status-coded border, steer the focused tile inline, and maximize any tile when you need the full session tools; keyboard-first (`Cmd/Ctrl+1..9` focus a slot, `Cmd/Ctrl+Enter` maximize, `Esc` restore), with preset and slot bindings persisted locally
- **Cross-machine grid (hub mode)** — grid slots can target any tailnet machine reachable through the hub: pick a machine in the slot composer to browse its projects, use its model catalog, and start or attach sessions there; remote tiles stream and steer live against that machine, show a reconnect state while it is down, and maximize into the session on the machine's own page
- **Inspector dock** — the session side panel (source control + pull request, files, terminal, browser on desktop) remembers whether it was open and its last tab across visits; the source-control tab now includes opening a PR and watching its checks

## Screenshots

> Screenshots live in [`assets/`](assets/) (added as needed). Until then, the in-app UI matches [`mockup.html`](mockup.html) (the UI blueprint used during development).

## Status

Phase 0–3 complete (vertical slice · PWA/mobile · steer + model picker) with agent-provider abstraction and Pi/Codex/Cursor providers. Phase 4 workspace support is partially shipped (project picker + Work locally/New worktree mode picker); PR flow/cleanup and Phase 5 (web push / webhooks) remain planned — see [Roadmap](#roadmap).

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

## SDK lane branches

Provider SDK work lands through integration branches before `main`:

```bash
cursor/<feature>  →  cursor-sdk  →  main
pi/<feature>      →  pi-sdk      →  main
codex/<feature>   →  codex-sdk   →  main
```

Use `codex/<slug>` branches for Codex provider work and open PRs against `codex-sdk`. Verify locally with:

```bash
BASE_REF=codex-sdk HEAD_REF=codex/my-feature bun run check-branch-flow
```

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3 (the server uses `bun:sqlite`, a Bun builtin — Node won't work).

```bash
bun install
cp .env.example .env   # optional but recommended in the main checkout
bun run dev
```

- **API:** http://localhost:3000/api/health
- **Web:** http://localhost:5173 (proxies `/api` → 3000)

### Local data (sessions & settings)

SQLite lives under `NUNCIO_DATA_DIR` (default: `./data` relative to the **server process cwd**, which is usually `apps/server/data/` when you run `bun run dev` from the repo root). Each git checkout or worktree without a shared path gets its **own empty database** — that is why a feature worktree can show an empty sidebar while your main clone has sessions.

**Recommended:** keep the shared runtime env in the main checkout and point it at one data directory:

```bash
cp .env.example .env
# edit if needed — default is $HOME/.nuncio/data
```

When you run `bun run dev` from a git worktree, the backend `dev`/`start` scripts auto-discover the main/primary checkout's `.env` first, so sessions/settings still come from the shared SQLite directory. Set `NUNCIO_ENV_FILE=/absolute/path/to/.env` when you intentionally want a different env file for one run.

Migrate existing data once (example if your sessions were under `apps/server/data/`):

```bash
mkdir -p ~/.nuncio/data
cp -a apps/server/data/. ~/.nuncio/data/
```

Restart `bun run dev` on port **3000** only — see [CONTRIBUTING.md → Dev server ports](CONTRIBUTING.md#dev-server-ports--dont-squat-new-ports).

```bash
bun run build   # build server + web
```

### Pi credentials

Nuncio drives the [Pi SDK](https://github.com/earendil-works/pi) in-process. Log in with the `pi` CLI first so `~/.pi/agent/auth.json` exists — it holds your API key **or** OAuth/subscription tokens (OpenAI, Anthropic). Override the agent directory with `PI_CODING_AGENT_DIR`. When no Pi credentials are configured, Nuncio falls back to a built-in **Mock** provider so the UI still works end-to-end.

### Cursor credentials

Set `CURSOR_API_KEY` (from [Cursor dashboard](https://cursor.com/dashboard/cloud-agents)) to enable the **Cursor** provider (`provider: "cursor"`). Uses `@cursor/sdk` local runtime under Bun with `useHttp1ForAgent` + `JsonlLocalAgentStore` escape hatches. Default cwd: `NUNCIO_CURSOR_CWD` or `process.cwd()`. Per-session `workspace` field (Phase 4 UI) overrides cwd when set. The key can also be set via the **Settings** UI (gear icon in the sidebar) — it's stored encrypted at rest and overrides the env var without a restart.

### Codex credentials

Nuncio launches the local Codex CLI's **app server** (`codex app-server`) for the **Codex** provider (`provider: "codex"`). Log in once with the CLI first:

```bash
codex login
codex login status
```

When `NUNCIO_CODEX_BIN` is unset or left as `codex`, Nuncio scans common local install paths plus `PATH`, probes each candidate with `--version` and `login status`, and auto-selects the only logged-in install. For launchd, desktop, or machines with multiple logged-in Codex CLIs, set `NUNCIO_CODEX_BIN` to the absolute CLI path (for example `~/.local/bin/codex`); ambiguous installs are rejected instead of guessing. Override Codex's home with `NUNCIO_CODEX_HOME`; override the default cwd with `NUNCIO_CODEX_CWD`. `NUNCIO_CODEX_RUNTIME_MODE=full-access` is the default for local self-hosted use. `approval-required` starts Codex in read-only/untrusted mode and surfaces pending provider approval requests in the session transcript. Pending request state is stored in SQLite; if the server restarts while Codex is waiting, Nuncio marks that stale request denied because the original app-server callback is gone. On graceful shutdown, Nuncio flushes buffered Codex deltas and closes reusable app-server clients.

### Provider CLI updates

Nuncio checks the installed Pi and Codex CLI versions against their public npm package versions and notifies when a newer version is available. It never auto-updates a CLI: users choose **Settings -> Providers -> Tool updates -> Update**.

- Pi uses the allowlisted native command `pi update`.
- Codex uses the detected package manager when possible (`npm`, `bun`, `pnpm`, or Homebrew). Standalone Codex installs show the official installer command as manual-only.
- Set `NUNCIO_PROVIDER_UPDATE_CHECKS=0` to disable checks and notifications. Set `NUNCIO_PI_BIN` or `NUNCIO_CODEX_BIN` when the CLI is not on `PATH` or multiple installs exist.

### Desktop browser profile

The browser dock is a desktop-only native Electron `BrowserView` embedded in the
session view. It uses Electron's persistent `persist:nuncio-browser` partition,
so cookies, cache, localStorage, and session storage survive app restarts without
touching your personal Chrome profile.

The web/PWA surface does not expose a browser dock. Normal browsers cannot embed
arbitrary sites like Google as a real child browser, and Nuncio intentionally
avoids presenting a streamed remote-browser viewport there.

## Testing

```bash
bun run test                                       # server unit tests (simulated providers)
bun run --filter @nuncio/server test:e2e           # HTTP e2e (simulated provider)
bun run --filter @nuncio/server test:integration   # real Pi auth — skips when ~/.pi/agent absent
bun run --filter @nuncio/server test:integration:codex # real Codex app-server — opt-in
bun run --filter @nuncio/web test                  # web component tests (vitest)
bun run test:daily-driver                          # server unit + e2e, core, web
bun run test:daily-driver:codex                    # daily-driver + real Codex smoke
```

All server tests run on `bun test` (no jest). The Pi integration suite is gated on `~/.pi/agent/auth.json` and self-skips when absent, so it is CI-safe. The Codex integration suite is explicitly opt-in via `NUNCIO_CODEX_INTEGRATION=1` (the script sets it), requires `codex login status`, and makes a real app-server model discovery call plus a short run/resume check.

## Production deploy (Tailscale)

Build and run the production stack on your machine, then expose it over Tailscale for HTTPS access from your phone or other devices on your tailnet.

```bash
bun run build
bun run --filter @nuncio/server start:prod   # API + built UI on :3000
tailscale serve --bg 3000
```

Open `https://<your-machine>.<tailnet>.ts.net` — Tailscale terminates TLS so iPhone PWA install works.

**Single-port serving:** In dev, Vite still runs on :5173 and proxies `/api` to the NestJS server on :3000. After `bun run build`, the Nest/Bun daemon serves `apps/web/dist` itself: `/api/*` remains JSON API traffic and every other app route falls back to the built SPA shell.

## Remote access & authentication

The server trusts loopback connections unconditionally — local use (desktop app, dev) needs zero
setup. Any non-loopback client (LAN, Tailscale, another machine) must present the server's access
token once.

- **Tailscale auto-trust:** if Tailscale runs on the server, devices signed into the **same
  Tailscale account** connect with no token at all — identity is verified per connection via
  `tailscale whois`. Manage it (and see your devices) in **Settings → Remote access**; other
  tailnet members' devices still need the token.
- The token is auto-generated on first boot, printed in the server log, shown in
  **Settings → Remote access**, and stored at `<dataDir>/auth-token` (see
  [Local data](#local-data-sessions--settings)). Override with `NUNCIO_AUTH_TOKEN`.
- Opening the web UI from another machine shows a one-time token prompt; on success the token is
  exchanged for an HttpOnly cookie (1 year), so each browser/device asks only once. The cookie
  also authenticates the SSE stream and the in-browser terminal.
- API clients can send `Authorization: Bearer <token>` per request instead.
- Forge webhooks (`/api/webhooks/forge/:provider`) are exempt — they verify their own HMAC signatures.

To work on a project that lives on another machine, run the server there and connect from here:

```bash
# one-shot: deploy the current working tree to a tailnet machine and register
# it as a user service (launchd on macOS, systemd --user on Linux)
scripts/remote/deploy.sh user@machine.tailnet.ts.net

# or manually on the project machine
bun run build && bun run --filter @nuncio/server start:prod
cat apps/server/data/auth-token   # or copy it from the boot log
```

`scripts/remote/deploy.sh` rsyncs the repo (never the target's `data/`) and runs
`scripts/remote/bootstrap.sh` there — idempotent, re-run it to update. On the same
Tailscale account you then connect with no token at all; otherwise open
`http://<machine>:3000` and paste the printed token once.

## PWA install (iPhone)

Nuncio ships as an installable PWA (`vite-plugin-pwa`: manifest, service worker, standalone display). **Add to Home Screen on iPhone requires HTTPS** — Safari will not offer a full install from plain `http://` localhost.

1. Deploy with Tailscale HTTPS (see [Production deploy](#production-deploy-tailscale) above).
2. On your iPhone, open the Tailscale URL in **Safari** (not an in-app browser).
3. Tap **Share** → **Add to Home Screen**.
4. Launch Nuncio from the home-screen icon — it runs in standalone mode with the dark theme and app icon.

The service worker precaches the UI shell; `/api/*` uses network-first so session data stays fresh.

## Architecture

- **Agent providers:** Pi SDK, Codex app-server, Cursor SDK, and Mock behind a common `AgentProvider` interface; `AgentRegistry` selects per session. Pi auth via the SDK's `AuthStorage` at `~/.pi/agent`; Codex auth via the local `codex` CLI login; Cursor auth via `CURSOR_API_KEY`. See [docs/system-architecture.md](docs/system-architecture.md).
- **Provider CLI updates:** Pi and Codex version checks run best-effort against public package metadata, surface optional notifications, and only run update commands after a user clicks Update.
- **Backend:** NestJS (`apps/server`) on port 3000; after `bun run build`, it also serves `apps/web/dist` at `/` while keeping `/api/*` for JSON routes
- **Frontend:** Vite + React + Tailwind + shadcn/ui (`apps/web`) on port 5173 in dev/preview (`NUNCIO_WEB_PORT` overrides dev/preview; `NUNCIO_API_ORIGIN` overrides the `/api` proxy target)
- **Browser dock:** desktop-only Electron `BrowserView` over the React viewport with a persistent app profile; web/PWA does not expose a browser dock
- **Persistence:** SQLite (`bun:sqlite`) in `data/nuncio.db` — sessions (with `provider`, `model`, and provider runtime state), append-only event log, and a `settings` table for runtime-configurable env overrides (secrets encrypted at rest)
- **Auth:** Tailscale (network) + static app token (planned)
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions (`?includeArchived=1`) |
| POST | `/api/sessions` | Create session `{ "prompt": "...", "provider?": "pi\|codex\|cursor", "model?": "...", "attachments?": [{ "kind": "image", "mimeType": "image/png", "data": "base64" }], "projectPath?": "/abs/repo", "useWorktree?": true, "baseBranch?": "main" }`; `projectPath` without `useWorktree` runs in the selected repo and records `baseBranch` as the selected branch, while `useWorktree: true` creates a generated `nuncio/<id>-<slug>` worktree from `baseBranch` |
| POST | `/api/sessions/handoff` | Import a Cursor IDE/CLI chat `{ "cursorChatId": "...", "workspace": "/abs/path", "title?": "..." }` or Pi CLI session `{ "piSessionPath": "/abs/session.jsonl", "workspace": "/abs/path", "title?": "..." }` → `IDLE` session with transcript hydrated |
| GET | `/api/cursor/local-sessions?workspace=` | List in-progress Cursor chats on this Mac for the handoff picker |
| GET | `/api/pi/local-sessions?workspace=` | List local Pi CLI sessions for a workspace using the Pi SDK session store |
| GET | `/api/sessions/:id` | Session detail (incl. `provider`, `model`, `supportsInteraction`, `cursorBackend`, `cursorChatId`) |
| GET | `/api/sessions/:id/events?since=` | Event log (cursor) |
| GET | `/api/sessions/:id/active-run` | `{ "active": boolean }` — whether Cursor IDE/CLI is likely still running this handoff chat on the host (transcript/store mtime < 60s) |
| POST | `/api/sessions/:id/refresh-transcript` | Append new turns from the on-disk Cursor/Pi transcript; emits `transcript_refreshed` via SSE when rows land |
| GET | `/api/sessions/:id/stream?since=` | SSE stream; for handoff sessions, the server watches the external transcript file and streams new rows live |
| POST | `/api/sessions/:id/steer` | Steer agent `{ "message": "...", "forceResume?": true, "attachments?": [...] }` — `forceResume` skips the active-run guard for CLI handoff sessions |
| POST | `/api/sessions/:id/interrupt` | Interrupt a live run when the provider advertises `capabilities.interrupt` (Pi supports this without disposing the session) |
| PATCH | `/api/sessions/:id/model` | Persist a session model/options update `{ "model": "provider:model", "options?": { ... } }`; providers with in-session switching (Pi) apply it live |
| POST | `/api/sessions/:id/interactions/:requestId/respond` | Submit answers for a live interactive tool prompt `{ "answers": [...], "resolvedBy": "user\|skip" }` |
| POST | `/api/sessions/:id/provider-requests/:requestId/respond` | Approve or deny a pending provider request `{ "decision": "approve" \| "deny" }` |
| POST | `/api/sessions/:id/pause` | Pause session |
| POST | `/api/sessions/:id/archive` | Archive session (recoverable via `restore`) |
| POST | `/api/sessions/:id/restore` | Restore an archived session → IDLE |
| DELETE | `/api/sessions/:id` | Permanently delete an archived session + its event log |
| GET | `/api/models` | Model catalog (aggregated from available providers, including per-provider `capabilities`) |
| GET | `/api/provider-updates` | Check Pi/Codex CLI versions and return optional update metadata |
| POST | `/api/provider-updates/:provider/update` | Run an allowlisted user-triggered update for `pi` or `codex` when supported |
| GET | `/api/settings` | List all settings (secrets masked, never raw) |
| PUT | `/api/settings/:key` | Update a setting `{ "value": "..." }` (encrypts secrets, busts provider caches) |
| DELETE | `/api/settings/:key` | Clear a setting (falls back to env/default) |
| GET | `/api/fs/dirs?path=` | Server-side directory browser (defaults to `$HOME`); used by the folder picker |
| POST | `/api/push/register` | Register a device Expo push token `{ "token": "...", "platform?": "ios\|android", "deviceName?": "..." }`; the server pushes on session finish / needs-input / error |
| POST | `/api/push/unregister` | Remove a device push token `{ "token": "..." }` |

### Session FSM

`CREATED` → `RUNNING` → `IDLE` | `ERROR` | `PAUSED`
`IDLE`/`PAUSED` → `RUNNING` (steer) · `IDLE`/`PAUSED`/`ERROR` → `ARCHIVED` · `ARCHIVED` → `IDLE` (restore)

Archived sessions are browsable in the sidebar's **Archived** tab (search by title/prompt, restore to IDLE, or delete permanently with a confirm dialog).

### Continue on mobile (handoff)

Pick **one** in-progress Cursor chat or Pi CLI session on your Mac and continue it from the Nuncio phone PWA without losing transcript context.

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

Imported Cursor sessions use `cursor_backend=cli` and resume via the CLI subprocess. Imported Pi sessions use `provider='pi'`, store the Pi session JSONL path in `providerThreadId`, and resume the same file in-process through `SessionManager.open(path)`. While a handoff session is open in Nuncio, server-side transcript file watchers stream new external CLI writes into the transcript without a manual refresh. Sessions you **create** in Nuncio still use the provider's normal in-process path (`cursor_backend=sdk` for Cursor).

## Project layout

```
apps/
  server/
    src/
      agents/        AgentProvider interface + BaseAgentProvider + AgentRegistry + providers/ (pi, codex, cursor)
      provider-updates/ optional Pi/Codex CLI version checks + user-triggered update endpoint
      sessions/      api/ · domain/ (types, fsm) · persistence/ (repositories) + service + module
      models/        model catalog aggregation from providers
      health/ · db/
    test/
      unit/          *.spec.ts (bun test)
      e2e/           HTTP e2e (simulated cursor provider)
      integration/   real Pi/Codex auth (skips unless matching local credentials are present; opt-in)
  web/      Vite + React + Tailwind v4 + shadcn/ui (installable PWA)
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
docs/       system-architecture.md
assets/     Screenshots for the README (un-ignored only here — see .gitignore)
```

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable) / Machine state (FSM)
- **Provider-neutral agent layer:** every agent SDK implements `AgentProvider`; `AgentRegistry` resolves per session so Pi/Codex/Cursor/any future SDK plug in uniformly
- **Per-session provider + model selection** — `provider` + `model` stored on the session, wired through to the SDK
- **Long-running, resumable sessions** — FSM + event log persist in SQLite; Pi conversation history is in-memory pending session revival (planned)

## Roadmap

Phase plans and milestones: [plans/260626-nuncio-roadmap/](plans/260626-nuncio-roadmap/)

| Phase | Focus | Status |
|-------|-------|--------|
| 0–1 | Vertical slice (sessions, events, SSE, Pi harness) | Done |
| 2 | PWA + mobile + Tailscale prod | Done |
| 3 | Steer, pause, model picker | Done |
| — | Agent-provider abstraction + Pi/Codex/Cursor providers | Done |
| 4 | Git workspace, branch, PR | Workspace support partially shipped; PR/cleanup planned |
| 5 | Web Push + webhooks | Planned |

## Contributing

Contributions are welcome! Before opening a PR:

- Read [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the TDD-first workflow, the Changeset-based release process, branch/worktree naming, and the PR checklist.
- For context on architecture and conventions, see [AGENTS.md](AGENTS.md) and [docs/system-architecture.md](docs/system-architecture.md).
- For the product north star (your-machine-as-cloud, pillars, non-goals), locked decisions, and the testing/self-verification playbook, see [docs/product-vision.md](docs/product-vision.md), [docs/architecture-decisions.md](docs/architecture-decisions.md), and [docs/testing-and-verification.md](docs/testing-and-verification.md).
- Found a security issue? See [SECURITY.md](SECURITY.md) — **do not** open a public issue for vulnerabilities.
- Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — © oscarlehuu. See the [LICENSE](LICENSE) file for the full text.
