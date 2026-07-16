<div align="center">

<img src="assets/logo-mark.png" alt="Nuncio logo" width="120" />

# Nuncio

**Self-hosted, mobile-first AI coding agents you run on your own machine.**

[![CI](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/ci.yml)
[![Release](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml/badge.svg)](https://github.com/oscarlehuu/nuncio/actions/workflows/release.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-f9f1e1?logo=bun)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [Architecture](#architecture) · [Contributing](#contributing)

</div>

Run it on your own machine, point it at your own Pi / Codex / Cursor / Claude credentials, and assign work from your phone — agents keep going while you're away, and you can steer them mid-task.

Think Devin, but self-hosted and provider-neutral: the agent layer is a single interface, so Pi, Codex, Cursor, and future agent SDKs plug in uniformly.

## Features

- **Delegate tasks** — create a session with a prompt; the agent runs in-process and streams output as events
- **Per-session provider + model** — choose the agent provider (`pi` / `codex` / `cursor` / `claude`) and the exact model (e.g. `codex:gpt-5.6-sol`, `cursor:composer-2`, `claude:sonnet`) per session; both are stored on the session and wired through to the provider runtime
- **Solo or Crew** — Solo keeps the per-session engine/model picker. Crew uses a saved Quality profile to bind independent Foreman, Builder, and Reviewer models across Pi, Codex, and Claude, then runs the fixed local workflow `Plan → Build → Verify → Review → Synthesize → Done` in one isolated worktree from the selected base branch on web or mobile. Nuncio owns deterministic verification, retry caps, writer authority, recovery, Attention blockers, and immutable successor runs; models never self-certify or silently switch providers.
- **Steer mid-task** — send follow-up messages that continue the same agent conversation when the provider supports it; live steers appear immediately, then reconcile in place if accepted or move to the existing queued-steers panel if the provider cannot take them yet
- **Live plans + structured questions** — Pi can maintain a replace-all `todo_write` checklist that streams through the provider-neutral `plan_updated` event into transcript cards and workbench progress. Its in-repo `AskUserQuestion` tool shows up to four position-numbered choices, supports notes/custom answers, and stores live answers on the resolved transcript event.
- **Multitasking subagents** — fan out prompts from an existing session into provider-neutral child tasks; each child becomes its own session, inherits the parent provider/model/workspace unless overridden, and waits for review when finished
- **Post-turn checks + auto-fix** — after a turn ends, Nuncio runs your project's check command (a `.nuncio/verify` script or the `NUNCIO_VERIFY_COMMAND` setting) and shows a passed/failed chip next to the session and on grid tiles. Optionally it feeds a failing run's output back to the agent and lets it try again: set `NUNCIO_VERIFY_AUTO_STEER` to enable and `NUNCIO_VERIFY_MAX_ROUNDS` (default 3) to cap the rounds; after that — or when two runs fail identically — the session is flagged as needing your attention. Auto-retries and the needs-attention state each get their own transcript row.
- **Autopilot loops** — hand a standing goal to a loop and let it run on a schedule (`daily@22:00`, `every:6h`, `mon@09:00`); each fire enqueues a task in a fresh worktree, runs the auto-fix loop above, and lands its work as a pull request. Loops respect a daily run budget, auto-pause after 3 consecutive failed runs (flagged as needing you), and can stop themselves after N total runs or N green verifies. Schedules, budgets, and the breaker are durable SQLite and rebuild at boot. Manage them in the **Autopilot** view — a dashboard with fleet stats and a 14-day sparkline, a template gallery for common loop shapes, a per-loop detail page with rename and a **Run now** button (with a truthful skip reason on a 409), and a global run history that drills into each run's verify output — scoped to per-project defaults (engine, worktree policy, verify command, auto-fix override) set in **Settings → Projects**, with a per-loop engine override on top. Each run's prompt is primed with a "previous run context" block (last outcome, failure streak, verify tail) so a loop picks up where it left off
- **Attention Inbox** — one ranked queue for everything that needs you: pending inputs/provider approvals, verify loops or Crew runs that need a decision, broken Autopilot loops, open PRs awaiting review, and fleet anomalies. Ack marks an item seen without resolving it; the sidebar badge counts only unacked open work.
- **Relay health watchdog** — `/api/relay/health` reports LAN, tailnet, and Funnel status with probe latency. The daemon may re-enable Funnel only after a read-only probe explicitly reports it down; healthy and indeterminate probes cannot enter the recovery path, and persistent failures raise Attention.
- **Heartbeat + digest** — Nuncio runs local self-checks for forge credentials and zombie sessions, reconciles the fleet and attention collectors on a cadence, and sends morning/evening digest pushes backed by an in-app digest view with real windowed counts, timeline highlights, and per-project summary lines.
- **Observability + timeline** — derive honest metrics and timeline facts from durable rows at `/api/observability/*` and `/api/timeline`, using bounded, indexed session-event projections for turns, steers, verify outcomes, and run durations without loading transcript/tool noise. Tasks, loop runs, attention, digests, and provider/project/day rollups remain part of the same folds. Token and cost fields stay `null` unless a provider reports structured usage.
- **Dispatcher proposals** — every evening, Nuncio drafts tomorrow's plan from durable attention, verify, task, loop, and PR facts as a dispatcher proposal; approve it in one tap to create queued tasks idempotently.
- **Home cockpit** — `/` is now the latest digest entry point and attention queue only. Fleet health stays available as a data layer for future project pages, while **Workbench** remains the multi-session grid at `/grid`; the new-session composer lives at `/new`.
- **Forge-aware project picker** — browse your GitHub/GitLab repos straight from the project picker (via your existing CLI credentials) and clone one directly into `NUNCIO_CLONE_DIR`; public repos clone anonymously first, while private clones inject a one-shot credential header for that single `git clone` that never persists into the repo
- **Forge feedback loop** — adopt an existing same-repository pull request into an isolated session with `POST /api/sessions/from-pr`; Nuncio checks out the provider's exact PR head, tracks its source branch upstream, and makes a plain `git push` update that source branch. Repeated adoption reuses the active owner, while concurrent creation is rejected by an atomic SQLite claim. Fork PR adoption fails closed so a push can never target the base repository by mistake. Signed GitHub/GitLab webhooks durably queue trusted repository-writer feedback and failed CI for the owning session, return `202` without waiting for the agent turn, and raise `pr-feedback` Attention if background delivery fails. Nuncio ignores feedback from its own connected forge login and only archives/removes a merged worktree when its session is IDLE, clean, and has no unpushed commits; removed or vanished worktree metadata falls back to the project path for later restore. Auto-steer and merge cleanup default on; configure `forges.autoSteer` / `forges.autoCloseOnMerge` or the `NUNCIO_FORGES_AUTO_STEER` / `NUNCIO_FORGES_AUTO_CLOSE_ON_MERGE` env fallbacks.
- **Pause / archive / restore / delete** — suspend a running session, retire it to the Archived tab, restore it back to IDLE, or permanently delete it; a session FSM enforces valid transitions and a confirm dialog guards deletes
- **Real-time + replay** — WebSocket relay (subscribe/steer on one duplex browser connection per complete relay URL, multiplexed session channels, gap-free resume via the event-log cursor — see [docs/ws-relay-contract.md](docs/ws-relay-contract.md)) plus the SSE stream and cursor replay endpoints for API consumers; each logical output segment commits and fans out its first delta immediately, later deltas coalesce in bounded bursts, and the web renders every received burst without a typewriter backlog. The web opens the relay after one microtask instead of waiting on REST, while per-consumer `seq` replay, late-bootstrap dedupe, half-open detection, and bounded slow-link recovery keep long answers exact
- **Mobile-first PWA** — installable on iPhone via Tailscale HTTPS; standalone dark UI, safe-area aware
- **Interactive browser dock** — desktop uses a real embedded Electron browser view with a persistent Nuncio profile; the web/PWA surface does not expose a browser dock
- **Self-hosted** — your machine, your SQLite, your credentials; nothing leaves your tailnet
- **Provider-neutral agent layer** — `AgentProvider` interface + `AgentRegistry`; Pi, Codex, Cursor, and Claude today (plus a source-only `NUNCIO_FORCE_MOCK=1`-gated Mock for hermetic testing), extensible
- **Runtime-aware agents** — every hosted agent receives a non-overridable Nuncio identity plus a truthful post-policy capability manifest without repeatedly polluting user turns; `nuncio_runtime_info` exposes the same session/tool/constraint facts where the engine supports adding it without breaking conversation continuity
- **Settings store** — runtime-configurable env vars (API keys, paths, flags) stored in SQLite and editable via the frontend; secrets encrypted at rest (AES-256-GCM), env vars still honoured as fallback
- **Trusted provider defaults** — Codex and Claude run with full workspace access by default; advanced provider settings can opt into approval-required modes, whose pending actions remain actionable in the transcript
- **Folder picker** — browse the host machine's directories to pick a project (server-side, works on iPhone PWA), or paste a custom path
- **Workspace control** — choose a project, run in the local checkout, or create a new `nuncio/<sessionId>-<slug>` worktree forked from the selected branch
- **Continue on mobile** — import an in-progress Cursor IDE/CLI chat or Pi CLI session from your Mac and steer it from the phone PWA (Cursor uses CLI `--resume`; Pi resumes in-process through the SDK)
- **Session grid** — a desktop-first multi-session workbench at `/grid`: lay out sessions in a 1x1/2x1/2x2/3x2 preset, read and scroll each tile's chat transcript with a status-coded border, steer the focused tile inline, and maximize any tile when you need the full session tools; keyboard-first (`Cmd/Ctrl+1..9` focus a slot, `Cmd/Ctrl+Enter` maximize, `Esc` restore), with preset and slot bindings persisted locally
- **Cross-machine grid (hub mode)** — grid slots can target any tailnet machine reachable through the hub: pick a machine in the slot composer to browse its projects, use its model catalog, and start or attach sessions there; remote tiles stream and steer live against that machine, show a reconnect state while it is down, and maximize into the session on the machine's own page
- **Inspector dock** — the session side panel (source control + pull request, files, terminal, browser on desktop) remembers whether it was open and its last tab across visits; the source-control tab now includes opening a PR, watching its checks, and reviewing the session worktree diff.
- **Diff review + hunk steering** — the session **Changes** panel shows structured worktree diffs with honest caps for binary, lockfile, too-large, and omitted files; tap a hunk, leave a comment, and Nuncio sends it back through the existing steer path, queued if the session is still running.
- **Screenshot evidence capture** — capture a session preview route with real headless Chrome or a booted iOS Simulator with `xcrun simctl`, bind the PNG to the workspace's exact Git HEAD, and keep only opaque media references in the durable transcript event. Simulator capture capability is explicit and degrades with a clear reason off macOS or without `xcrun`.
- **Nuncio MCP server** — expose read-mostly Nuncio context plus constrained task enqueue / loop pause tools to local agent hosts over stdio with `bun run mcp`; the server is a thin proxy over the running daemon and never calls model APIs.

## Screenshots

**Home cockpit** — pick a repo, choose Solo/Crew, provider and model, then delegate a task.

![Nuncio home cockpit with the task composer and session sidebar](assets/home-cockpit.png)

**A session at work** — the agent streams its plan, tool calls, and results live; the inspector dock gives you source control, files, and a terminal alongside the transcript.

![A Nuncio session streaming an agent's plan, tool calls, and terminal](assets/session-agent-run.png)

**Provider-neutral model picker** — Pi ("Nuncio Engine"), Codex, Cursor, and Claude plug into one interface; switch model and thinking level per session.

![The per-session provider and model picker showing Nuncio Engine and Codex models](assets/model-picker.png)

> More images live in [`assets/`](assets/). The in-app UI also matches [`mockup.html`](mockup.html) (the UI blueprint used during development).

## Status

Rungs 0–4 are shipped through Intelligence: provider-neutral sessions, mobile/PWA, steer/model selection, workspace/Fleet/attention/diff review, observability, global timeline, local MCP, and dispatcher proposals. Promotion/release hardening and later automation rungs remain planned — see [Roadmap](#roadmap).

Crew MVP is implemented and verified for the `dev` integration lane. It is not yet part of the
stable release. The baseline is the fixed local Quality workflow
`PLAN -> BUILD -> VERIFY -> REVIEW -> SYNTHESIZE -> DONE`, with Solo still the default.

## Changelog

Releases are versioned and documented with [Changesets](https://github.com/changesets/changesets) — each pull request ships a hand-written summary fragment, so the changelog reads like curated release notes rather than a commit log.

- **In app:** open the sidebar → ✨ **What's new** (bottom-left) to browse every release, grouped by version and category, with links back to the pull requests that shipped each change.
- **On GitHub:** each release is published as a [GitHub Release](https://github.com/oscarlehuu/nuncio/releases) with the matching changelog section as the body, tagged `v<version>`.
- **In the repo:** [`CHANGELOG.md`](CHANGELOG.md) is the single source of truth.

To add a changelog entry for your PR:

```bash
bun run changeset        # select "nuncio", pick minor/patch, write a release-note-style summary
```

Merging PRs triggers a `chore: release version` PR that bumps the version and updates `CHANGELOG.md`; merging that PR creates the tag and a draft GitHub Release, then publishes it after the signed desktop assets and updater manifest upload. See [`.changeset/README.md`](.changeset/README.md) and [AGENTS.md → Releases & changelog](AGENTS.md) for the full workflow.

## Branch model

Two long-lived branches: **`dev`** (integration — produces Nuncio Dev builds) and **`main`** (stable releases):

```bash
<type>/<slug> (worktree from dev)  →  dev  →  main   (promotion)
changeset-release/*                →  main           (release bot)
```

Feature work happens on `<type>/<slug>` branches (e.g. `feat/composer-autofocus`) created as git worktrees from `dev`, with PRs opened against `dev`. Only `dev` and the Changesets release bot merge to `main`. Verify locally with:

```bash
BASE_REF=main HEAD_REF=dev bun run check-branch-flow
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

### MCP server

With the daemon running, expose Nuncio to local agent hosts over stdio:

```bash
bun --silent run mcp
```

Set `NUNCIO_API_ORIGIN` to target another daemon and `NUNCIO_AUTH_TOKEN` for non-loopback access. See [docs/nuncio-mcp.md](docs/nuncio-mcp.md).

### Local data (sessions & settings)

SQLite lives under `NUNCIO_DATA_DIR` (default: `./data` relative to the **server process cwd**, which is usually `apps/server/data/` when you run `bun run dev` from the repo root). Each git checkout or worktree without a shared path gets its **own empty database** — that is why a feature worktree can show an empty sidebar while your main clone has sessions.

**Recommended:** keep the shared runtime env in the main checkout and point it at one data directory:

```bash
cp .env.example .env
# edit if needed — default is $HOME/.nuncio/data
```

When you run `bun run dev` from a git worktree, the backend `dev`/`start` scripts auto-discover the main/primary checkout's `.env` first, so sessions/settings still come from the shared SQLite directory. Set `NUNCIO_ENV_FILE=/absolute/path/to/.env` when you intentionally want a different env file for one run.

Long-running sessions have a stall watchdog: if a provider stays `RUNNING` without emitting any session event for 30 minutes, Nuncio disposes that runtime, records `runtime_stalled`, moves the session back to `IDLE`, and drains any queued steer so you can resume from the durable event log. Override with `NUNCIO_STALLED_RUN_FORCE_IDLE_MS=<milliseconds>`; set it to `0` to disable.

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

Nuncio drives the [Pi SDK](https://github.com/earendil-works/pi) in-process. Start `pi`, run `/login`, and choose each built-in provider you want Pi to use (for example Anthropic, OpenAI, Google, or xAI). Pi writes the resulting API-key or OAuth/subscription credentials to `~/.pi/agent/auth.json`; Nuncio reads that Pi-managed auth file but never opens an auth prompt. Override the agent directory with `PI_CODING_AGENT_DIR`. Restart the Nuncio daemon after changing Pi logins: only providers with currently available registry models appear in the picker, grouped under **Nuncio Engine** (internal id `pi`) using Pi registry display names. When no provider is configured at all, session creation returns `503`; for hermetic testing without any credentials in a source checkout, start the server with `NUNCIO_FORCE_MOCK=1` to register the built-in **Mock** provider (used by `bun run test:smoke-ui`). Packaged desktop builds set `NUNCIO_PACKAGED=1`, ignore that flag, and never register Mock.

Nuncio Engine shares Pi's `auth.json` and SDK session plumbing, but it does **not** load the Pi CLI's personal `models.json`. It loads Pi's built-ins plus an optional, user-owned Pi-format file at `<PI_AGENT_DIR>/nuncio-models.json` (normally `~/.pi/agent/nuncio-models.json`). The file may define any private proxy/provider; when it is absent, no custom provider appears. Override its location with `NUNCIO_PI_MODELS_PATH`. Nuncio never creates or edits this file, and no custom provider is hardcoded into the product. Nuncio Engine sessions deny extension discovery by default and load only Nuncio's explicit allowlist from the Pi agent directory. Set `PI_EXTENSION_DISCOVERY=full` only when you intentionally want Pi's normal global and project extension discovery for Solo sessions; explicit Crew runtime-policy sessions remain hermetic. Nuncio Engine injects bounded project facts and HandoffBrief context via `nuncio-context` (`appendSystemPrompt`) on every session unless disabled.

Nuncio Engine can also reuse project-relevant memories already curated by Claude Code and Codex CLI without copying or modifying either store. It injects only a compact, byte-bounded index and exposes `read_external_memory` for full read-only access to an indexed item. `PI_EXTERNAL_MEMORIES` selects `off`, `claude`, `codex`, or `all` (default); `PI_EXTERNAL_MEMORIES_MAX_BYTES` controls the index budget (default 12288, hard cap 16384). Claude memories resolve from `NUNCIO_CLAUDE_CONFIG_DIR`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`; Codex memories resolve from `NUNCIO_CODEX_HOME`, then `~/.codex`. Worktree sessions also match the owning repository path.

Nuncio uses Pi SDK `0.80.6` metadata directly for built-in models, so authenticated Gemini, Grok, GPT, Claude, and other built-ins appear without a Nuncio allowlist; optional user providers declare their own metadata in `nuncio-models.json`. Standard thinking levels through **High** are available unless a model marks one unsupported; **Extra High** and **Max** appear only when that exact model advertises them. Image upload is enabled only when the selected registry model advertises image input. Pi **Max** remains a single-agent thinking level and is not renamed to Codex **Ultra**, which activates multi-agent delegation. If Pi automatically retries a failed attempt and later completes successfully, Nuncio now settles the session from that successful completion instead of surfacing the earlier transient error.

### Cursor credentials

Set `CURSOR_API_KEY` (from [Cursor dashboard](https://cursor.com/dashboard/cloud-agents)) to enable the **Cursor** provider (`provider: "cursor"`). Uses `@cursor/sdk` local runtime under Bun with `useHttp1ForAgent` + `JsonlLocalAgentStore` escape hatches. Default cwd: `NUNCIO_CURSOR_CWD` or `process.cwd()`. Per-session `workspace` field (Phase 4 UI) overrides cwd when set. The key can also be set via the **Settings** UI (gear icon in the sidebar) — it's stored encrypted at rest and overrides the env var without a restart.

### Codex credentials

Nuncio launches the local Codex CLI's **app server** (`codex app-server`) for the **Codex** provider (`provider: "codex"`). Log in once with the CLI first:

```bash
codex login
codex login status
```

When `NUNCIO_CODEX_BIN` is unset or left as `codex`, Nuncio scans common local install paths plus `PATH`, probes each candidate with `--version` and `login status`, and auto-selects the only logged-in install. For launchd, desktop, or machines with multiple logged-in Codex CLIs, set `NUNCIO_CODEX_BIN` to the absolute CLI path (for example `~/.local/bin/codex`); ambiguous installs are rejected instead of guessing. Override Codex's home with `NUNCIO_CODEX_HOME`; override the default cwd with `NUNCIO_CODEX_CWD`. `NUNCIO_CODEX_RUNTIME_MODE=full-access` is the default for local self-hosted use. `approval-required` starts Codex in read-only/untrusted mode and surfaces pending provider approval requests in the session transcript. Nuncio also mirrors Codex app-server thread names into session titles when Codex generates or returns a better name. Pending request state is stored in SQLite; if the server restarts while Codex is waiting, Nuncio marks that stale request denied because the original app-server callback is gone. On graceful shutdown, Nuncio flushes buffered Codex deltas and closes reusable app-server clients.

Codex model and effort choices come from the running app-server rather than a Nuncio allowlist. Codex CLI `0.144.0` and newer can advertise GPT-5.6 Sol, Terra, and Luna with their account-specific availability. Sol and Terra currently expose **Ultra**, while Luna stops at **Max**. Max gives one agent more reasoning time; Ultra activates Codex's proactive multi-agent delegation and uses more tokens. Nuncio labels that distinction in the shared effort slider, forwards the advertised value as `turn/start.effort`, and resets a saved effort when the selected model no longer supports it. Update/select the CLI under **Settings -> Providers -> Tool updates**, then set an absolute `NUNCIO_CODEX_BIN` when multiple logged-in installations are present. See the official [Codex model guide](https://developers.openai.com/codex/models/).

### Claude credentials

Nuncio runs **Claude Code** in-process through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for the **Claude** provider (`provider: "claude"`); the SDK spawns and manages a bundled Claude Code CLI subprocess per active session. Two auth paths, no OAuth flow inside Nuncio:

- **Logged-in Claude Code (subscription ride).** If you have logged into Claude Code on this machine (`claude /login`), Nuncio rides the shared keychain automatically — the SDK's bundled binary reports the same `auth status` as your system `claude`, so no separate install and no API key are needed.
- **`ANTHROPIC_API_KEY`.** Set the key (env var or the **Settings** UI, stored encrypted at rest, no restart needed) to run via the API for the distribution path. When set, it takes precedence and Nuncio skips the login probe.

Sessions are fully isolated from your `~/.claude` config: no plugins, hooks, or `CLAUDE.md` leak in (`settingSources` is empty by default). Trusted workspaces default to `bypassPermissions`, so Claude can edit files and run tools without pausing for approval. Override this advanced provider setting with `NUNCIO_CLAUDE_PERMISSION_MODE` (`default`, `acceptEdits`, `plan`, or `bypassPermissions`); approval-bearing modes continue to surface pending actions in the transcript. Images are supported (paste into the composer). The session runs in the per-session `workspace` (project picker / worktree); resume is cwd-scoped, so the stored session survives a daemon restart and continues in the same directory. Point at a specific CLI build with `NUNCIO_CLAUDE_BIN` when the bundled binary is unavailable.

### Provider CLI updates

Nuncio checks the installed Pi and Codex CLI versions against their public npm package versions and notifies when a newer version is available. It never auto-updates a CLI: users choose **Settings -> Providers -> Tool updates -> Update**.

- Pi uses the allowlisted native command `pi update`.
- Codex uses the detected package manager when possible (`npm`, `bun`, `pnpm`, or Homebrew). Standalone Codex installs show the official installer command as manual-only.
- Set `NUNCIO_PROVIDER_UPDATE_CHECKS=0` to disable checks and notifications. Set `NUNCIO_CLI_UPDATE_NOTIFICATIONS=0` to keep manual checks but silence update toasts, or set `NUNCIO_CLI_UPDATE_MUTED=pi,codex` to mute selected provider notifications.
- Set `NUNCIO_PI_BIN` or `NUNCIO_CODEX_BIN` when the CLI is not on `PATH` or multiple installs exist.

### Desktop browser profile

Agents and API clients use one stable browser contract with `target` set to
`auto`, `in_app`, or `external`. The default target is configurable in
**Settings -> MCP & Tools -> Default browser** via
`NUNCIO_BROWSER_DEFAULT_TARGET`; the shipped default is `auto`, which prefers
the desktop in-app browser when the Electron shell is connected, then falls back
to the Nuncio-owned Chrome CDP browser. Provider-specific adapters (Pi custom
tools, Cursor local custom tools, and Codex dynamic tools) receive it through the
shared `AgentRuntimeTools` registry instead of implementing their own browser
behavior.

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
bun run --filter @nuncio/server mcp                # stdio MCP server
bun run --filter @nuncio/server test:integration:claude # real Claude Agent SDK — opt-in
bun run --filter @nuncio/web test                  # web component tests (vitest)
bun run test:daily-driver                          # server unit + e2e, core, web
bun run test:daily-driver:codex                    # daily-driver + real Codex smoke
```

All server tests run on `bun test` (no jest). The Pi integration suite is gated on `~/.pi/agent/auth.json` and self-skips when absent, so it is CI-safe. The Codex integration suite is explicitly opt-in via `NUNCIO_CODEX_INTEGRATION=1` (the script sets it), requires `codex login status`, and makes a real app-server model discovery call plus a short run/resume check. The Claude integration suite is opt-in via `NUNCIO_CLAUDE_INTEGRATION=1`, self-skips unless the Agent SDK reports a logged-in Claude Code (or `ANTHROPIC_API_KEY`), and exercises a real run, steer, interrupt, and resume-from-a-fresh-provider against the cheapest model in an isolated tmp workspace.

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

- **Agent providers:** Pi SDK, Codex app-server, Cursor SDK, and Claude Agent SDK (plus a source-only `NUNCIO_FORCE_MOCK=1`-gated Mock for testing) behind a common `AgentProvider` interface; `AgentRegistry` selects per session. Pi auth via the SDK's `AuthStorage` at `~/.pi/agent`; Codex auth via the local `codex` CLI login; Cursor auth via `CURSOR_API_KEY`; Claude auth via a logged-in Claude Code keychain or `ANTHROPIC_API_KEY`. See [docs/system-architecture.md](docs/system-architecture.md).
- **Agent runtime awareness:** `SessionsService` builds an immutable Nuncio identity and post-policy capability manifest in `AgentRunContext.runtimeEnvironment`. Pi uses native `appendSystemPrompt`, Codex uses `developerInstructions` on start/resume, and Claude uses its full native `appendSystemPrompt`; all three send exact user turns. Claude rebuilds and resumes a completed native query when the runtime-instruction signature changes. Cursor SDK 1.0.22 has no native system/developer channel, so Nuncio sends one deterministic, versioned runtime bootstrap with the first provider message and keeps later user turns exact.
- **Agent runtime tools:** `AgentToolRegistry` binds per-session tools such as browser control into `AgentRunContext.tools`; providers adapt that once into Pi `customTools`, Cursor `local.customTools`, Codex `dynamicTools`, or Claude MCP tools. The read-only `nuncio_runtime_info` tool reports the authoritative host/session/tool/constraint snapshot; Codex intentionally receives the same data through `developerInstructions` so adding the tool cannot invalidate persisted dynamic-tool surfaces.
- **Crew workspace harness:** a durable `CrewTask` owns immutable `CrewRun` revisions above the existing Task/Session primitives. The Crew reducer is the sole transition authority; one writer lease confines Builder, Foreman/Reviewer run read-only, mandatory verify runs in Seatbelt on macOS or bubblewrap on Linux against a full Git HEAD, and provider sessions are reused only when their frozen binding, policy, and workspace remain compatible. A project `.nuncio/verify` must be tracked at the selected frozen base SHA (it is invoked with `sh`, so no executable bit is required), and Builder checkpoint commits require repository-local `user.name`/`user.email`. Full redacted verify/diff artifacts are read progressively through integrity-checked byte ranges. See [docs/crew-workspace-harness.md](docs/crew-workspace-harness.md) and [docs/crew-run-authority-and-state-machine.md](docs/crew-run-authority-and-state-machine.md).
- **Provider CLI updates:** Pi and Codex version checks run best-effort against public package metadata, surface optional notifications, and only run update commands after a user clicks Update.
- **Backend:** NestJS (`apps/server`) on port 3000; after `bun run build`, it also serves `apps/web/dist` at `/` while keeping `/api/*` for JSON routes
- **Frontend:** Vite + React + Tailwind + shadcn/ui (`apps/web`) on port 5173 in dev/preview (`NUNCIO_WEB_PORT` overrides dev/preview; `NUNCIO_API_ORIGIN` overrides the `/api` proxy target)
- **Browser dock:** desktop-only Electron `BrowserView` over the React viewport with a persistent app profile; web/PWA does not expose a browser dock
- **Persistence:** SQLite (`bun:sqlite`) in `data/nuncio.db` — sessions (with `provider`, `model`, and provider runtime state), append-only event log, and a `settings` table for runtime-configurable env overrides (secrets encrypted at rest)
- **Settings UI:** Cursor-style sectioned settings page with search, provider/source-control connection rows, MCP/tool defaults, local agent defaults, workspace paths, remote access, and advanced controls
- **Task queue + subagents:** durable `/api/tasks` queue with `parentSessionId` links for multitasking child agents; the session composer can fan out via its multitask button or `/multitask <prompt>`, and `NUNCIO_TASK_CONCURRENCY` caps how many queued tasks/subagents run at once
- **Auth:** Tailscale (network) + static app token (planned)
- **Distribution:** Open source — friends/colleagues self-host on their own Linux/macOS machines

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/relay/health` | Probe `{ lan, tailnet, funnel }`; each path returns `status` (`up\|down\|unknown`), `latencyMs`, `probedAt`, and an optional `reason`. LAN and tailnet latency use their health URLs; Funnel reports read-only CLI configuration health because an ambiguous same-host fetch cannot prove public reachability. |
| GET | `/api/sessions` | List sessions (`?includeArchived=1`) |
| POST | `/api/sessions` | Create session `{ "prompt": "...", "provider?": "pi\|codex\|cursor\|claude", "model?": "...", "attachments?": [{ "kind": "image", "mimeType": "image/png", "data": "base64" }], "projectPath?": "/abs/repo", "useWorktree?": true, "baseBranch?": "main" }`; `projectPath` without `useWorktree` runs in the selected repo and records `baseBranch` as the selected branch, while `useWorktree: true` creates a generated `nuncio/<id>-<slug>` worktree from `baseBranch` |
| POST | `/api/sessions/from-pr` | Adopt an existing GitHub PR or GitLab MR `{ "path": "/abs/repo", "number": 123 }` into a new worktree session based on its source branch; returns `{ "sessionId": "..." }` |
| POST | `/api/sessions/handoff` | Import a Cursor IDE/CLI chat `{ "cursorChatId": "...", "workspace": "/abs/path", "title?": "..." }` or Pi CLI session `{ "piSessionPath": "/abs/session.jsonl", "workspace": "/abs/path", "title?": "..." }` → `IDLE` session with transcript hydrated |
| GET | `/api/cursor/local-sessions?workspace=` | List in-progress Cursor chats on this Mac for the handoff picker |
| GET | `/api/pi/local-sessions?workspace=` | List local Pi CLI sessions for a workspace using the Pi SDK session store |
| GET | `/api/sessions/:id` | Session detail (incl. `provider`, `model`, `supportsInteraction`, `cursorBackend`, `cursorChatId`) |
| GET | `/api/sessions/:id/events?since=` | Event log (cursor) |
| GET | `/api/sessions/:id/active-run` | `{ "active": boolean }` — whether Cursor IDE/CLI is likely still running this handoff chat on the host (transcript/store mtime < 60s) |
| POST | `/api/sessions/:id/refresh-transcript` | Append new turns from the on-disk Cursor/Pi transcript; emits `transcript_refreshed` via SSE when rows land |
| GET | `/api/sessions/:id/stream?since=` | SSE stream; for handoff sessions, the server watches the external transcript file and streams new rows live |
| POST | `/api/sessions/:id/steer` | Steer agent `{ "message": "...", "forceResume?": true, "attachments?": [...] }` — `forceResume` skips the active-run guard for CLI handoff sessions |
| POST | `/api/sessions/:id/evidence` | Capture browser evidence with `{ "target?": "browser", "url": "http://localhost:5173", "route?": "/app", "phase": "before\|after" }` or a booted iOS Simulator with `{ "target": "simulator", "phase": "before\|after" }`. Both store through `MediaStore`, return the same PNG ref/route/viewport/workspace-HEAD shape, and append `evidence_captured`; an unstaged browser runtime returns `{ "unavailable": true, "reason": "Browser capture unavailable" }` without an event, while unavailable Simulator capability returns a clear error and appends nothing. |
| POST | `/api/sessions/:id/interrupt` | Interrupt a live run when the provider advertises `capabilities.interrupt` (Pi supports this without disposing the session) |
| PATCH | `/api/sessions/:id/model` | Persist a session model/options update `{ "model": "provider:model", "options?": { ... } }`; providers with in-session switching (Pi) apply it live |
| POST | `/api/sessions/:id/interactions/:requestId/respond` | Submit answers for a live interactive tool prompt `{ "answers": [...], "resolvedBy": "user\|skip" }` |
| POST | `/api/sessions/:id/provider-requests/:requestId/respond` | Approve or deny a pending provider request `{ "decision": "approve" \| "deny" }` |
| POST | `/api/sessions/:id/pause` | Pause session |
| POST | `/api/sessions/:id/archive` | Archive session (recoverable via `restore`) |
| POST | `/api/sessions/:id/restore` | Restore an archived session → IDLE |
| DELETE | `/api/sessions/:id` | Permanently delete an archived session + its event log |
| GET | `/api/tasks?parentSessionId=` | List durable queued/running/finished tasks, optionally filtered to child subagents of a parent session |
| POST | `/api/tasks` | Queue a standalone task `{ "prompt": "...", "provider?": "pi\|codex\|cursor", "model?": "...", "projectPath?": "/abs/repo", "useWorktree?": true }` |
| POST | `/api/tasks/multitask` | Fan out child subagent tasks from an ordinary parent session `{ "parentSessionId": "...", "prompts": ["..."], "provider?": "...", "model?": "...", "cleanupPolicy?": "after-review\|manual\|never" }`; omitted provider/model/workspace inherit from the parent or subagent defaults; Crew-owned member sessions are rejected so this path cannot bypass Crew authority or its one-writer lease |
| POST | `/api/tasks/:id/reviewed` | Mark a finished child subagent task as reviewed so cleanup policy can act on it |
| POST | `/api/tasks/:id/cancel` | Cancel a queued task before it starts |
| POST | `/api/tasks/:id/retry` | Clone a finished task back into the queue |
| DELETE | `/api/tasks/:id` | Delete a terminal task row |
| GET | `/api/models` | Model catalog (aggregated from available providers, including per-provider `capabilities`) |
| GET | `/api/usage` | Live subscription quotas for Claude / Codex / Cursor (reads local CLI logins; `?forceRefresh=true` bypasses TTL cache). Claude / Codex / Cursor also append Today + Last 30 Days token totals when local logs expose usage (Cursor best-effort). |
| GET | `/api/usage/history` | Last N days (default 90, max 90) of local token totals per provider for Settings analytics (`?days=` + `?forceRefresh=true`) |
| GET | `/api/usage/:provider` | Single-provider quota snapshot (`claude` \| `codex` \| `cursor`) |
| GET/POST | `/api/crew/profiles` | List or create saved Quality Crew profiles; updates use `PATCH /api/crew/profiles/:id` with `expectedRevision`, and `POST /api/crew/profiles/:id/resolve` validates live bindings plus the project verify command |
| POST | `/api/crew/tasks` | Create a Crew task `{ "objective": "...", "projectPath": "/abs/repo", "baseBranch?": "main", "profileId": "..." }` and start its first immutable run |
| GET | `/api/crew/tasks/:id` | Read the stable Crew task and its immutable run history; `POST /api/crew/tasks/:id/runs` creates an exact-head successor for a terminal run |
| GET | `/api/crew-runs?status=&projectPath=&limit=&offset=` | Read a bounded, latest-per-task summary page (default 20, maximum 100); excludes profile snapshots, context, worktree paths, and other full-run state |
| GET | `/api/crew-runs/:id` | Read the projected run, member sessions, sanitized artifact metadata, deterministic gate evidence, and typed final result |
| GET | `/api/crew-runs/:id/events?since=` | Read the append-only Crew event cursor |
| GET | `/api/crew-runs/:runId/artifacts/:artifactId?offset=&limit=` | Read a run-scoped redacted artifact range; defaults to 16,384 bytes, caps at 65,536, and returns UTF-8-safe `nextOffset` + `eof` |
| POST | `/api/crew-runs/:id/{pause,resume,cancel,clarification,extra-round}` | Apply one of the five guarded local actions with `expectedRevision`; no generic transition or external-write endpoint exists |
| GET | `/api/provider-updates` | Check Pi/Codex CLI versions and return optional update metadata |
| POST | `/api/provider-updates/:provider/update` | Run an allowlisted user-triggered update for `pi` or `codex` when supported |
| GET | `/api/settings` | List all settings with section categories (secrets masked, never raw) |
| PUT | `/api/settings/:key` | Update a setting `{ "value": "..." }` (encrypts secrets, busts provider caches) |
| DELETE | `/api/settings/:key` | Clear a setting (falls back to env/default) |
| GET | `/api/fs/dirs?path=` | Server-side directory browser (defaults to `$HOME`); used by the folder picker |
| POST | `/api/sessions/:id/browser/open` | Open the session browser `{ "url?": "https://example.com", "target?": "auto\|in_app\|external" }`; `auto` prefers the desktop in-app browser when connected and falls back to the Nuncio-owned CDP browser |
| GET | `/api/sessions/:id/browser/state?target=auto\|in_app\|external` | Return current browser URL/title/loading state plus the resolved target |
| GET | `/api/sessions/:id/browser/screenshot?target=auto\|in_app\|external` | Return a PNG screenshot from the selected session browser |
| POST | `/api/sessions/:id/browser/input` | Send browser input `{ "type": "click\|text\|key\|scroll", ..., "target?": "auto\|in_app\|external" }` |
| POST | `/api/push/register` | Register a device Expo push token `{ "token": "...", "platform?": "ios\|android", "deviceName?": "..." }`; the server pushes on session finish / needs-input / error |
| POST | `/api/push/unregister` | Remove a device push token `{ "token": "..." }` |
| POST | `/api/devices/:deviceId/push-token` | Register the paired device's Expo push token `{ "token": "ExponentPushToken[...]", "platform": "ios\|android" }` using its `Bearer nd1.<deviceId>.<deviceSecret>` credential; returns `{ "ok": true }` |

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
      agents/        AgentProvider interface + BaseAgentProvider + AgentRegistry + providers/ (pi, codex, cursor, claude)
      evidence/      browser/simulator screenshot capture + Git HEAD witness
      crew/          fixed Crew workflow, profile resolver, runner/recovery, context, artifacts, gates, persistence
      provider-updates/ optional Pi/Codex CLI version checks + user-triggered update endpoint
      sessions/      api/ · domain/ (types, fsm) · persistence/ (repositories) + service + module
      models/        model catalog aggregation from providers
      health/ · db/
    test/
      unit/          *.spec.ts (bun test)
      e2e/           HTTP e2e (simulated Cursor + forced-Mock Crew workflow)
      integration/   real Pi/Codex auth (skips unless matching local credentials are present; opt-in)
  web/      Vite + React + Tailwind v4 + shadcn/ui (installable PWA)
mockup.html UI blueprint (reference)
data/       SQLite (gitignored)
docs/       product-vision, architecture-decisions, product-surfaces, system-architecture, …
assets/     Screenshots for the README (un-ignored only here — see .gitignore)
```

## Design principles

- **3-layer state decoupling:** Conversation (durable) / Agent loop (replaceable) / Machine state (FSM)
- **Provider-neutral agent layer:** every agent SDK implements `AgentProvider`; `AgentRegistry` resolves per session so Pi/Codex/Cursor/any future SDK plug in uniformly
- **Workspace harness above provider loops:** Crew shares durable context and Git evidence, not hidden reasoning or provider caches; each provider retains its own conversation runtime while Nuncio owns the outer workflow and authority boundary
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
| — | Provider-neutral Quality Crew workspace harness | Implemented and verified for the `dev` lane |
| 4 | Git workspace, branch, PR | Workspace, PR adoption, feedback routing, and guarded merge cleanup shipped |
| 5 | Web Push + webhooks | Push and forge webhook automation shipped |

## Contributing

Contributions are welcome! Before opening a PR:

- Read [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the TDD-first workflow, the Changeset-based release process, branch/worktree naming, and the PR checklist.
- For context on architecture and conventions, see [AGENTS.md](AGENTS.md) and [docs/system-architecture.md](docs/system-architecture.md).
- For the product north star (your-machine-as-cloud, pillars, non-goals), locked decisions, **where each capability appears across clients**, and the testing/self-verification playbook, see [docs/product-vision.md](docs/product-vision.md), [docs/architecture-decisions.md](docs/architecture-decisions.md), [docs/product-surfaces.md](docs/product-surfaces.md), and [docs/testing-and-verification.md](docs/testing-and-verification.md).
- Found a security issue? See [SECURITY.md](SECURITY.md) — **do not** open a public issue for vulnerabilities.
- Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — © oscarlehuu. See the [LICENSE](LICENSE) file for the full text.
