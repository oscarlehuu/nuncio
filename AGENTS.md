# AGENTS.md

Context file for AI coding agents working on Nuncio. Read this before touching the codebase.

> **Work TDD-first.** Always start from a failing test. Implement only what makes it pass. A change is not done while the suite is red. See [Working practice: TDD-first](#working-practice-tdd-first).
> **Need a decision from the user? Answer TL;DR.** One-line recommendation first, then the trade-off in a sentence (what you gain vs. lose), then the options. No long preamble — the user decides fast.

## What is Nuncio

Nuncio is a **self-hosted, Devin-style web app for delegating tasks to AI agents**. Built for daily personal use, especially on mobile: you delegate a task from your phone, the agent runs on your always-on Mac, you come back later to review the output.

- **Deployment model:** single process on a personal Mac, exposed over **Tailscale HTTPS** so the phone (or friends on the tailnet) can reach it. No VPS, no public domain.
- **Distribution:** open source — friends/colleagues self-host on their own machines. MIT.
- **Mental model:** async-first. A session is a self-contained task (not a realtime chat). Create → agent runs in background → stream/review → steer/pause/archive.
- **Agent harness is provider-agnostic by design.** Pi SDK is the **inaugural** provider — the architecture is meant to host any agent SDK (Cursor, OpenAI/Claude agents, …) behind one common contract. See [Agent providers](#agent-providers).
- **Runtime:** Bun (server, build, tests). See [Bun runtime](#bun-runtime).

## Working practice: TDD-first

**Always start from a test.** No implementation code lands without a failing test that specifies the behavior first. Red → Green → Refactor, every change:

1. **Red — write the test first.** Add a `*.spec.ts` under `apps/server/test/unit/<domain>/` (grouped by domain, not co-located) that captures the desired behavior. Run it (`bun test test/unit/<domain>/…`) and confirm it fails for the *right* reason (a real assertion failure, not a compile/import error).
2. **Green — implement the minimum** to make the test pass. No more, no less.
3. **Refactor** under the safety of the passing test.
4. **Gate:** the change is not done until the suite is green. Don't move on, don't commit, don't open a PR on a red suite. **Never silence, skip, or weaken a failing test just to pass the build.**
5. **Docs sync:** update `README.md` to match the shipped code — commands, API, architecture, status. If architecture or conventions shifted, update `AGENTS.md` too. A merged change with stale docs isn't done.

Grounding in what exists today:

- **Server (`apps/server`):** `bun test`. Specs are grouped by domain under `apps/server/test/unit/<domain>/` (e.g. `test/unit/agents/`, `test/unit/sessions/`, `test/unit/models/`, `test/unit/db/`) plus `test/unit/app.spec.ts` (HTTP via `supertest`); e2e in `test/e2e/app.e2e-spec.ts`; real-Pi integration in `test/integration/pi-agent.integration.spec.ts`. Run `bun run test` (unit), `bun run test:e2e` (e2e), `bun run test:integration` (integration — gated on `~/.pi/agent/auth.json`, opt-in; makes a real LLM call).
- **Frontend (`apps/web`):** Vitest (jsdom + Testing Library) is wired — `bun run --filter @nuncio/web test` runs `vitest run`, specs co-located as `*.spec.tsx`. For frontend changes, keep `bun run --filter @nuncio/web build` + `bun run --filter @nuncio/web lint` + `bun run --filter @nuncio/web test` green and verify visual changes against `mockup.html` (and the light/dark toggle). TDD applies end-to-end — write the failing spec first, watch it fail, then implement.

Bugs: write a test that reproduces the bug (red), then fix (green). No bug fix without a regression test. Refactors: keep existing tests green throughout — if a refactor requires changing tests, it isn't a refactor, it's a behavior change; split it.

## Agent workflow (multi-agent sessions)

Agents working on Nuncio often **share the same branch** — they are not each given an isolated worktree/branch by default. Coordinate with what is already running on the machine.

### Dev servers — reuse canonical ports

| Service | Port | Start command |
|---|---|---|
| API | **3000** | `bun run --filter @nuncio/server start` (preferred for Cursor) or `dev` |
| Web | **5173** | `bun run --filter @nuncio/web dev` |
| Both | 3000 + 5173 | `bun run dev` |

Before starting a server, check whether **3000** or **5173** is already in use.

- If a Nuncio process is already listening: **stop it and restart on that same port** — do **not** spin up a second instance on 5174, 5175, etc. Extra ports break the Vite `/api` proxy assumption, confuse browser bookmarks, and leave orphan processes.
- To restart: kill the existing PID (or stop the terminal job), then start again on the canonical port.
- For **Cursor provider** testing, use `start` (no `--watch`) — see [Gotchas](#gotchas).

### Subagents (Cursor Agents)

When delegating work via Cursor's Task/subagent tooling, set the subagent model to **`composer-2.5`** unless the user specifies a different model.

### Code review gate

After each implementation — and **before commit or PR** — run a **code review** pass (code-reviewer agent, Bugbot, or equivalent). Fix blockers; document warnings in the PR or lane report. **Tests green alone is not done** — review is part of the shipping gate.

## Tech stack

| Layer | Choice |
|---|---|
| Agent harness | **Provider-agnostic by design** — any agent SDK behind a common `AgentProvider` contract. **Pi SDK** (`@earendil-works/pi-coding-agent`) is the inaugural provider, run in-process via `createAgentSession`; **mock provider** is the always-available fallback when no provider is authed or `NUNCIO_FORCE_MOCK=1`. Cursor and other SDKs plug into the same contract. |
| Backend | NestJS 11 (`apps/server`) on port **3000**, runs on Bun |
| Frontend | Vite 8 + React 19 + Tailwind 4 + **shadcn/ui (nova preset, light + dark)** (`apps/web`) on port **5173** (proxies `/api` → 3000); installable **PWA** via `vite-plugin-pwa`. shadcn primitives (Radix-based) in `components/ui/`, composed into feature components; nova oklch semantic tokens adopted directly. See [shadcn/ui adoption](#shadcnui-adoption). |
| Persistence | SQLite (`bun:sqlite`) at `data/nuncio.db`, WAL mode |
| Streaming | **SSE** (`EventSource`) — not WebSocket. Events are append-only with a `seq` cursor |
| Auth | Tailscale (network layer) + planned static app token |
| Runtime | **Bun ≥ 1.3** (server, build, tests) — server requires Bun (`bun:sqlite` is a Bun builtin). See [Bun runtime](#bun-runtime). |

## Commands

```bash
bun install
bun run dev          # server (3000) + web (5173) concurrently
bun run build        # build server + web
bun run test         # server unit (bun test test/unit/)
bun run lint         # server tsc --noEmit + web oxlint
```

Per-workspace (via `bun run --filter`):

```bash
bun run --filter @nuncio/server build            # nest build
bun run --filter @nuncio/server test             # bun test test/unit/
bun run --filter @nuncio/server test:e2e         # bun test test/e2e/app.e2e-spec.ts
bun run --filter @nuncio/server test:integration # bun test test/integration/ (real Pi, opt-in)
bun run --filter @nuncio/server lint             # tsc --noEmit
bun run --filter @nuncio/web build               # tsc -b && vite build
bun run --filter @nuncio/web test                # vitest run
bun run --filter @nuncio/web lint                # oxlint
bun run --filter @nuncio/web preview             # serve built UI (proxies /api → 3000)
```

Production (Tailscale):

```bash
bun run build
bun run --filter @nuncio/server start:prod   # bun run dist/main.js, API on :3000
bun run --filter @nuncio/web preview         # UI on :5173
tailscale serve --bg 5173                    # https://<machine>.<tailnet>.ts.net
```

iPhone PWA install requires HTTPS — use the Tailscale URL in Safari → Share → Add to Home Screen.

## Project layout

```
apps/
  server/                NestJS API + provider-agnostic agent harness (Bun runtime)
    src/
      health/            health.module/controller
      agents/            provider-agnostic harness
        agents.types.ts        AgentProvider interface, AgentRunContext, EventEmitter type
        agents.base-provider.ts BaseAgentProvider (template-method: status/emit/error orchestration)
        agents.registry.ts     AgentRegistry (per-session provider resolution)
        agents.module.ts       wires providers + registry, exports registry
        providers/
          pi-agent.provider.ts   Pi provider (inaugural) — real agent via Pi SDK
          mock-agent.provider.ts mock provider — always-available fallback
      sessions/          session domain: FSM, repos, service, controller
        api/sessions.controller.ts       REST endpoints
        domain/sessions.fsm.ts           pure transition table + assertTransition/canTransition
        domain/sessions.types.ts         DTOs + row types (SessionRow, SessionDto, CreateSessionDto, …)
        persistence/sessions.repository.ts  (positional ? params — bun:sqlite)
        persistence/events.repository.ts   append-only event log (seq cursor)
        sessions.service.ts              orchestrator; injects repos + AgentRegistry
        sessions.module.ts               imports AgentsModule + SessionsPersistenceModule
        sessions.persistence.module.ts   exports repositories (shared by Sessions + Agents modules)
      models/            model catalog (thin: aggregates listModels() across available providers)
        models.types.ts        ModelProviderDto/ModelGroupDto/ModelItemDto
        models.static.ts       STATIC_MODEL_PROVIDERS (Pi fallback when no auth)
        models.service.ts      aggregates from AgentRegistry
      settings/          DB-backed env config (settings store)
        settings.types.ts        SettingDefinition, SettingDto, UpdateSettingDto
        settings.registry.ts     SETTING_DEFINITIONS (declarative catalog) + getSettingDefinition/isSecretSetting
        settings.crypto.ts       AES-256-GCM encrypt/decrypt + maskSecret + loadSettingsKey
        settings.service.ts      SettingsService (resolve DB→env→default, onChange cache-bust) + SETTINGS_KEY token
        persistence/settings.repository.ts  CRUD on settings table
        api/settings.controller.ts          GET/PUT/DELETE /api/settings (secret masking)
        settings.module.ts       wires repo + SETTINGS_KEY factory + service + controller
      git/                 git worktree + project discovery (Phase 4 workspace)
        git.service.ts         listProjects, listBranches, createWorktree (reads paths via SettingsService)
        git.controller.ts        GET /api/projects, GET /api/projects/branches
      fs/                 server-side directory browser (host filesystem navigation for the folder picker)
        fs.types.ts            DirEntryDto, DirListingDto
        fs.service.ts          listDirectories(path) — resolves ~ / relative, filters noise, marks .git
        fs.controller.ts       GET /api/fs/dirs?path=
        fs.module.ts
      db/                DatabaseService (Global, bun:sqlite, schema bootstrap + guarded ALTER migration; exposes dataDir)
    test/
      unit/<domain>/     bun test unit specs grouped by domain (agents/, sessions/, models/, db/) + app.spec.ts
      e2e/app.e2e-spec.ts        e2e over HTTP (mock provider; run via bun run test:e2e)
      integration/pi-agent.integration.spec.ts  real-Pi integration (gated on ~/.pi/agent/auth.json; opt-in)
  web/                   Vite + React + Tailwind v4 + shadcn/ui (PWA)
    src/
      lib/               api.ts, use-session-stream.ts (SSE hook), model-providers.ts, projects.ts, utils.ts (cn())
      components/
        ui/              shadcn primitives (Radix-based) — generated, rarely hand-edited
        home-view, session-detail, sidebar, model-picker, project-picker, branch-picker, status-dot  (feature components)
      App.tsx            top-level state + view routing
mockup.html              UI blueprint / reference (single-file mockup)
data/                    SQLite (gitignored)
plans/                   phased roadmap + per-phase reports
```

## Architecture

### Three-layer state decoupling (core principle)

1. **Conversation (durable)** — append-only event log in SQLite. Source of truth; survives restarts.
2. **Agent loop (replaceable)** — the in-process agent session owned by the active provider (Pi `AgentSession` today). Can be killed/revived; state is rebuildable from the event log. The provider is replaceable; the loop contract is not.
3. **Machine state (FSM)** — `sessions.status` column, a small finite state machine.

This separation lets sessions be long-running and resumable: the agent loop is disposable, the conversation is not.

### Session FSM

`apps/server/src/sessions/domain/sessions.fsm.ts` — pure functions over a transition table. **Always go through `assertTransition`/`canTransition`** when changing status; never set `status` directly outside the service.

```
CREATED → RUNNING | ERROR
RUNNING → IDLE | ERROR | PAUSED
IDLE    → RUNNING | ERROR | PAUSED | ARCHIVED
PAUSED  → RUNNING | ARCHIVED
ARCHIVED → (terminal)
ERROR   → RUNNING | IDLE | ARCHIVED
```

`ARCHIVED` is terminal. `archive()` also disposes the session's agent handle via `agents.get(session.provider).dispose(id)` (routes through the provider).

### Agent providers

The harness is provider-agnostic: an `AgentProvider` runs/steers/disposes a session and knows its own model catalog. **Pi is the inaugural provider** — it is what's wired today — but any agent SDK is meant to implement the same contract and register alongside it.

**Today (Pi + Cursor + mock, abstracted):** the `apps/server/src/agents/` module defines the `AgentProvider` interface (`agents.types.ts`), a `BaseAgentProvider` abstract class (`agents.base-provider.ts`) using the template-method pattern, and an `AgentRegistry` (`agents.registry.ts`). `BaseAgentProvider.run()`/`steer()` own the shared orchestration (set RUNNING → push user/steer message → `executePrompt()` → set IDLE, with unified error handling); concrete providers implement only `executePrompt()`. `PiAgentProvider` runs the Pi SDK in-process and keeps a `Map<sessionId, PiSessionHandle>` alive after the first run so `steer()` reuses the same Pi session; it token-streams via `session.subscribe()` `text_delta` → `assistant_delta`. `CursorAgentProvider` runs `@cursor/sdk` local runtime in-process (`await Agent.create` + `send({ onDelta })` + `wait`), token-streams via `onDelta` `text-delta` → `assistant_delta` (and `tool-call-started`/`completed` → `tool_start`/`tool_end`), and reuses the same agent handle per session for steer. `MockAgentProvider` is the always-available fallback. The `EventEmitter` type lives in `agents.types.ts`. See [Token streaming](#token-streaming-per-provider-delta-sources) for the per-provider delta sources behind the shared event contract.

`SessionsService` injects `AgentRegistry` and resolves the provider **per-session** from `sessions.provider` on `create`/`steer`/`archive`. `CreateSessionDto.provider?` defaults to `registry.defaultId()` (cursor if `CURSOR_API_KEY` set, else pi if authed, else mock); unavailable providers are rejected at create time. `ModelsService` is thin — it aggregates `listModels()` across `registry.available()`. See [Agent provider abstraction](#agent-provider-abstraction) for what shipped vs. what remains.

### Streaming

- Agent → `SessionsService` via an `emit` callback → appended to `events` table (auto-incrementing `seq` per session) → fanned out to SSE subscribers via an in-memory `EventEmitter` bus per session.
- Client (`use-session-stream.ts`): fetch events since `0`, open `EventSource` with `?since=<seq>`, dedupe by `seq`, reconnect on `visibilitychange`.
- Event log is the cursor: `GET /api/sessions/:id/events?since=` and `GET /api/sessions/:id/stream?since=` (SSE).

#### Token streaming (per-provider delta sources)

The event contract is **shared** across providers (emitted via `BaseAgentProvider.pushEvent`): `assistant_delta { delta }` (token-by-token text), `tool_start { tool }` / `tool_end { tool, isError }`, `assistant_message { text }` (final), `status` / `error`. The frontend `Transcript` consumes `assistant_delta` uniformly — no per-provider UI branching. Each provider only differs in **how it obtains deltas from its SDK**:

| Provider | Delta source | Maps to |
|---|---|---|
| **Pi** | `session.subscribe()` → `message_update` → `assistantMessageEvent.type === 'text_delta'` (token-level) | `assistant_delta` |
| **Cursor** | `agent.send(text, { onDelta })` → `InteractionUpdate.type === 'text-delta'` (token-level); `tool-call-started` / `tool-call-completed` | `assistant_delta` / `tool_start` / `tool_end` |
| Mock | simulated delta stream | `assistant_delta` |

> **Adding a new engine?** Check whether its SDK exposes a token-level streaming callback (Pi: `subscribe` + `text_delta`; Cursor: `onDelta` + `text-delta`). Map it to the shared `assistant_delta { delta }` event so the frontend `Transcript` streams without changes. If the SDK only offers block-level messages, fall back to emitting the whole block as one `assistant_delta` (block-level) — the transcript still renders, just less smoothly. Do NOT introduce a per-provider event type; the contract stays shared.

### Persistence

`DatabaseService` (Global injectable) opens `bun:sqlite` (`require('bun:sqlite')` — see [Bun runtime](#bun-runtime)), sets `journal_mode=WAL` via `db.exec('PRAGMA journal_mode = WAL')`, and runs `CREATE TABLE IF NOT EXISTS` for `sessions` + `events` + `settings`. **There is no migration framework.** Schema changes for existing DBs must be added as a manual `ALTER TABLE` guarded by `PRAGMA table_info(...)` checks — the `provider` column migration in `DatabaseService.migrate()` is the template. The `settings` table holds runtime-configurable env overrides; secret-typed values are stored as AES-256-GCM ciphertext (see [Settings store](#settings-store)).

## API (Phase 0–4)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | health check |
| GET | `/api/projects` | list git repos from `NUNCIO_PROJECT_ROOTS` (one level deep) |
| GET | `/api/projects/branches?path=` | list branches for a repo path (also accepts custom absolute paths) |
| GET | `/api/sessions` | list (excludes `ARCHIVED` unless `?includeArchived=1\|true`) |
| POST | `/api/sessions` | `{ prompt, model?, provider?, workspace?, projectPath?, baseBranch? }` — when `projectPath` is set, creates a git worktree on branch `nuncio/<id>-<slug>` branched from `baseBranch` (default `main`); `workspace` is the Cursor provider cwd fallback; starts run in background; `provider` defaults to `registry.defaultId()` (cursor if `CURSOR_API_KEY` set, else pi if authed, else mock) |
| GET | `/api/sessions/:id` | detail (includes `workspace`, `projectPath`, `baseBranch`, `worktreePath`, `branch` when set) |
| GET | `/api/sessions/:id/events?since=` | event log (cursor) |
| GET | `/api/sessions/:id/stream?since=` | SSE stream |
| POST | `/api/sessions/:id/steer` | `{ message }` — mid-run steering (routes through `provider.steer()`; Pi uses `streamingBehavior: 'steer'`) |
| POST | `/api/sessions/:id/pause` | |
| POST | `/api/sessions/:id/archive` | terminal; disposes the session's agent handle (worktree + branch kept on disk) |
| GET | `/api/models` | aggregates `listModels()` across `AgentRegistry.available()` (Pi `ModelRegistry` when authed, Cursor `Cursor.models.list()` when `CURSOR_API_KEY` set, else static fallback; mock returns a mock entry) |
| GET | `/api/settings` | list all settings (catalog metadata + `hasValue` + `source` + masked/raw `value`; secrets masked, never raw) |
| GET | `/api/settings/:key` | single setting DTO (404 for unknown key) |
| PUT | `/api/settings/:key` | `{ value }` — persists (encrypts secrets), busts provider caches, returns the masked DTO |
| DELETE | `/api/settings/:key` | clears the DB row (falls back to env/default), busts caches, returns the resulting DTO |
| GET | `/api/fs/dirs?path=` | server-side directory browser — lists subdirectories of `path` (defaults to `$HOME`); returns `{ current, parent, entries: [{ name, path, isGit }] }`. Filters dotfiles + `node_modules` + `.git`. Used by the frontend folder picker (browsers can't expose host paths). |

Model selection is **per-session** (Provider → Group → Model, 3-level picker on the frontend) and **wired through to Pi**: the session's `model` (stored as `provider:modelId`, e.g. `anthropic:claude-opus-4-5`) flows via `AgentRunContext.model` → `PiAgentProvider.resolveModelId()` → `ModelRegistry.find(provider, id)` → `createAgentSession({ model })`. Static ids without a `:` (only present when Pi registry is empty / no auth) fall back to Pi's default. `provider` is also per-session, resolved from `sessions.provider` on `steer`/`archive`.

**Workspace (Phase 4):** optional `projectPath` + `baseBranch` on create. Server runs `git worktree add -b nuncio/<id>-<slug> ~/.nuncio/workspaces/<id> <baseBranch>` before the agent run. `AgentRunContext.cwd` = `worktreePath` → Pi `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) })`. Frontend uses server-driven project discovery (`ProjectPicker` + `BranchPicker` comboboxes) — no browser filesystem API (Safari/iOS PWA safe).

## Code conventions

- **NestJS domain modules:** one module per domain (`agents`, `sessions`, `models`, `health`, `db`). Repositories wrap `bun:sqlite` (via `DatabaseService.db`); services hold the logic and are injected into controllers. `SessionsPersistenceModule` exports the repositories so `SessionsModule` and `AgentsModule` both get them without a circular dependency.
- **Repository pattern:** `SessionsRepository` / `EventsRepository` own all SQL (positional `?` params). Services never touch `DatabaseService.db` directly.
- **DTOs** live in `sessions/domain/sessions.types.ts` (`SessionRow`, `SessionDto`, `CreateSessionDto`, `SteerSessionDto`). Row types (`*_row`, snake_case columns) are mapped to DTOs (`camelCase`) in repositories.
- **FSM is pure:** `sessions/domain/sessions.fsm.ts` has no dependencies; `TRANSITIONS` map + `assertTransition`/`canTransition`.
- **Tests:** `bun test`, `*.spec.ts` grouped by domain under `apps/server/test/unit/<domain>/` (NOT co-located with source — the reorg moved them out deliberately for maintainability at scale); e2e under `apps/server/test/e2e/`; integration under `apps/server/test/integration/`. Layout mirrors the src domain split (`agents/`, `sessions/`, `models/`, `settings/`, `db/`). `bun run test` (unit) and `bun run test:e2e` (e2e) must stay green. Specs are written **before** implementation (TDD) — see [Working practice: TDD-first](#working-practice-tdd-first).
- **Frontend:** Vite + React 19 + Tailwind v4 + **shadcn/ui (nova preset, light + dark)**. Primitives live in `components/ui/` (Radix-based, generated via shadcn CLI — avoid hand-editing unless fixing a primitive bug); feature components in `components/` compose them. Class merging through `cn()` in `lib/utils.ts` — no raw template-string concatenation for conditional classes. Icons via `lucide-react` (no inline SVG). Path alias `@/*` → `src`. Data/API in `lib/`, `App.tsx` is the state container. SSE via `EventSource` (no WS client). Theme is the nova oklch token system in `index.css` (`:root` light + `.dark` dark) with a Vite-native `ThemeProvider` + `ModeToggle` (see [shadcn/ui adoption](#shadcnui-adoption)).
- **File naming:** kebab-case, descriptive names. Keep files focused; modularize when a file grows past ~200 lines.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). No AI references in messages. Keep commits focused on real code changes.
- **Imports at the top of the file** — no inline imports. Exhaustive `switch` over unions (use a `never` check in `default`).

## Env / config

Env vars are the **fallback** for the settings store. Every var below (except the boot-only group) is overridable at runtime via `PUT /api/settings/:key` and the Settings UI — see [Settings store](#settings-store). Env still works unchanged when no DB row exists.

| Var | Default | Purpose | DB-overridable? |
|---|---|---|---|
| `NUNCIO_DATA_DIR` | `./data` | SQLite directory | ❌ boot-only |
| `PORT` | `3000` | server listen port | ❌ boot-only |
| `NUNCIO_SETTINGS_KEY` | (generated) | 32-byte AES-256-GCM key for secret settings (hex or base64). If absent, a key is generated at `data/settings.key` (mode 0600). | ❌ boot-only (chicken-egg) |
| `NUNCIO_PROJECT_ROOTS` | (empty) | Comma-separated dirs to scan one level deep for git repos (frontend project picker) | ✅ |
| `NUNCIO_WORKSPACES_DIR` | `~/.nuncio/workspaces` | Per-session git worktree parent dir (`<dir>/<sessionId>`) | ✅ |
| `NUNCIO_FORCE_MOCK` | — | `1` forces mock agent even with Pi auth | ✅ |
| `CURSOR_API_KEY` | — | Cursor SDK auth; required for `cursor` provider availability (mint at cursor.com/dashboard/cloud-agents). Stored encrypted at rest. | ✅ (secret) |
| `NUNCIO_CURSOR_CWD` | `process.cwd()` | Default cwd for Cursor local agents when session has no `workspace` | ✅ |
| `PI_AGENT_DIR` / `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi auth/config root (`auth.json`, models). The directory path is configurable; the `auth.json` *contents* are read-only (managed by the `pi` CLI). | ✅ |

Pi auth is reused as-is from `~/.pi/agent/auth.json` (single source of truth shared with the `pi` CLI).

### Settings store

Runtime-configurable env vars live in a `settings` SQLite table and are configurable via the frontend (gear icon in the sidebar) or `PUT /api/settings/:key`. The resolution order is **DB → env → registry default**, so existing env-based deployments keep working without any DB writes (back-compat). Changing a setting via the API busts provider caches (`AgentRegistry.bustCaches()`) so a rotated `CURSOR_API_KEY` flips provider availability without a restart.

- **Secrets** (type=`secret`, e.g. `CURSOR_API_KEY`) are encrypted at rest with AES-256-GCM (`settings.crypto.ts`). The API never returns raw secret values — only a masked preview (`••••last4`) and `hasValue`.
- **Catalog** is declarative in `settings.registry.ts` — adding a future provider's credentials = one entry, no schema/API change.
- **Pi credentials** are file-based (`~/.pi/agent/auth.json`); the frontend shows the configured path but the auth contents are managed by the `pi` CLI (read-only).
- **Schema:** `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`. No migration framework — the table is created on boot by `DatabaseService`.

## Roadmap & status

| Phase | Focus | Status |
|---|---|---|
| 0–1 | monorepo scaffold, sessions API, UI | done |
| 2 | PWA + mobile UX + Tailscale prod | done |
| 3 | steer, pause, archive, model picker | done |
| 4 | git integration (workspace/branch/PR) | workspace subset done (`worktree` + pickers + Pi `cwd`); PR/cleanup deferred |
| 5 | web push + webhooks | planned |

> Runtime migration to Bun landed (see [Bun runtime](#bun-runtime)). Agent-provider abstraction + shadcn/ui also landed.

Plans: `plans/260626-nuncio-roadmap/`. Per-phase reports: `plans/reports/`.

### Parallel-agent lane convention

When a phase is large it is split into lanes working on isolated branches, then merged:

| Lane | Ownership |
|---|---|
| A — Backend | `apps/server/src/**` (except `*.spec.ts`) |
| B — Frontend | `apps/web/src/**` |
| C — Tests + Docs | `*.spec.ts`, `apps/server/test/**`, `README.md`, `plans/reports/` |

- Branches: `cursor/phase-NN-<lane>-5323`, combined into `cursor/phase-NN-combined-5323`.
- **File ownership is strict** — no overlapping edits across lanes. Tests own test files only and read (never edit) implementation files.
- Merge order is defined per phase in `phase-NN-orchestration.md`; verify with `bun run build && bun test` after each merge.
- Each lane writes a short report to `plans/reports/phase-NN-<lane>-report.md` (status, what shipped, verify commands, unresolved).

## Agent provider abstraction

**Status: shipped.** The `agents/` module, `AgentProvider` interface, `BaseAgentProvider` template-method base, and `AgentRegistry` have landed; `PiAgentService`/`MockAgentService` migrated to `PiAgentProvider`/`MockAgentProvider`; `SessionsService` injects `AgentRegistry` and resolves the provider per-session; `ModelsService` aggregates `listModels()` across available providers. A `provider` column was added to `sessions` with a guarded `ALTER TABLE` migration in `DatabaseService.migrate()` (existing dev DBs are handled). The old `EventEmitter`-in-`mock-agent.service.ts` coupling is gone — the type lives in `agents.types.ts`. `SessionsPersistenceModule` was extracted to export the repositories to both `SessionsModule` and `AgentsModule` without a circular dependency.

**Cursor provider (shipped):** `CursorAgentProvider` implements `AgentProvider` via `@cursor/sdk` local runtime. Uses `await Agent.create({ local: { cwd, useHttp1ForAgent: true, store: new JsonlLocalAgentStore(dir) } })` — both escape hatches required for Bun compat (HTTP/1.1 avoids `NGHTTP2_FRAME_SIZE_ERROR`; JSONL store avoids `node:sqlite`). `isAvailable()` checks `CURSOR_API_KEY` env only (no network); invalid keys surface at first `Agent.create` (hits `GET /v1/models` immediately) → session ERROR. `dispose()` calls sync `agent.close()`. Final assistant text from `result.result` (authoritative per SDK docs). `listModels()` caches `Cursor.models.list()` once per process, omitting the SDK's `default` model entry. `defaultId()` prefers cursor when `CURSOR_API_KEY` is set.

**Remaining gaps:** Pi uses `SessionManager.inMemory()`, so active Pi sessions are lost on server restart and a `steer` on a revived session creates a fresh Pi session (conversation history is replayed from the event log, not restored into Pi) — the lazy-revive design (`SessionManager.create(cwd)` / `open(path)`) from the brainstorm is not yet implemented. Pi's `tools: ['read','bash','grep','find','ls']` are hardcoded (not configurable per session or via env). Cursor provider uses env-configured cwd (`NUNCIO_CURSOR_CWD`) until Phase 4 per-session worktree; concurrent Cursor sessions share cwd (file-conflict risk). Cursor agent handles lost on server restart (same as Pi in-memory), though `JsonlLocalAgentStore` persists state for future `Agent.resume()`. Cloud runtime (GitHub repo + PR) not yet supported. The `resolveModelId` logic is unit-tested with a stub `find`, but there is no integration test that exercises real `~/.pi/agent/auth.json` end-to-end (would be skipped when auth is absent). Cursor integration test (`test/integration/cursor-agent.integration.spec.ts`) is gated on `CURSOR_API_KEY`.

## shadcn/ui adoption

**Status: complete.** The frontend uses **shadcn/ui** with the **nova** preset (`components.json` `style: "radix-nova"`, base color neutral, icon library lucide) and a **light + dark toggle**. The old hand-rolled Tailwind v4 palette (`--color-bg-*`, `--color-text-*`, `--color-accent`, `--color-border*`) has been removed; all feature components compose shadcn primitives and nova semantic tokens directly.

**Theme system:** nova oklch semantic tokens live in `apps/web/src/index.css` — `:root` (light) and `.dark` (dark) define `--background`, `--foreground`, `--primary`, `--card`, `--popover`, `--secondary`, `--muted`, `--border`, `--input`, `--ring`, `--destructive`, `--chart-*`, `--sidebar-*`, `--radius`; `@theme inline` exposes them to Tailwind. `ThemeProvider` (`components/theme-provider.tsx`, Vite-native — **not** `next-themes`) toggles `.dark` on `<html>`, persists `nuncio-theme` to `localStorage`, and follows `system` via `matchMedia`. `ModeToggle` (`components/mode-toggle.tsx`, `Button` + `DropdownMenu`) offers Light/Dark/System. `App` is wrapped in `<ThemeProvider>` in `main.tsx`; `Toaster` (sonner) reuses the same `useTheme`.

**Custom additions where shadcn/nova has no equivalent** (defined in a small `@theme` block in `index.css`): `--color-success` / `--color-error` / `--color-info` (status-dot uses `bg-success`/`bg-info`; ERROR uses nova `bg-destructive`) and `--font-mono` / `--font-serif`. This is the explicit "self-make where shadcn lacks" set — everything else uses nova tokens.

**Installed primitives** (`components/ui/`, CLI-generated via `bunx shadcn@latest add … --cwd apps/web`): `button`, `badge`, `dropdown-menu`, `sheet`, `sonner`, `textarea`, `input`, `command`, `popover`, `tooltip`, `separator` (plus `dialog`, `input-group` pulled as dependencies). The nova preset ships `button` on init.

**Feature components** (`components/`) compose the primitives:

- `App.tsx` — flex shell; static `<aside>` (desktop) + `Sheet` (mobile drawer) for the sidebar; `Menu` trigger (lucide) with iOS safe-area offset; `Toaster`. Owns the `providers` state (fetches `/api/models` once) and passes it down to `HomeView` + `SessionDetail` so model-name lookups use the live catalog, not the static fallback.
- `sidebar.tsx` — `Button` (New Agent), sticky footer with Settings + `ModeToggle`, `bg-sidebar`/`sidebar-accent`/`sidebar-ring` tokens, `StatusDot`, and a per-session `ProviderIcon`. Mobile `Sheet` uses `showCloseButton={false}` (dismiss via hamburger or overlay).
- `home-view.tsx` — `Textarea` (borderless inside a `bg-card` composer), `Button` (send, `Send` icon, `aria-label="Send"`), `Badge` (one "connected" badge per available provider, filtered by `unavailable` + session count).
- `model-picker.tsx` — Synara-style **cascading `DropdownMenu`** (engine → model): top level lists providers (`π Pi` / `◆ Cursor` / `M Mock`) as `DropdownMenuSubTrigger`; each opens a `DropdownMenuSubContent` with a `DropdownMenuRadioGroup` of that provider's models. Selecting a model fires `onChange(modelId, providerId)` and closes the menu. Replaces the old flat `Command`-in-`Popover` combobox. Receives `providers` as a controlled prop from `App` (no internal fetch). Model labels run through `prettyModelName()` (e.g. `composer-2.5` → "Composer 2.5"). Re-exports `DEFAULT_MODEL_ID`.
- `session-detail.tsx` — `Button` (back/pause/archive, lucide icons, `Tooltip` + `TooltipProvider`), `Badge` (status + model pill), `Textarea` (steer composer). Model pill resolves the friendly name via `modelById(providers)` → `prettyModelName()` with `FALLBACK_PROVIDERS` fallback; unknown models fall back to the raw id.
- `status-dot.tsx` — semantic tokens (`bg-muted-foreground`, `bg-success`, `bg-info`, `bg-destructive`) + `cn()`.
- `provider-icon.tsx` — branded SVG glyphs for known providers (`CursorIcon` real Cursor logo, `PiIcon` real Pi logo, both `fill="currentColor"` so they adapt to light/dark); `ProviderIcon({ providerId, className })` maps `cursor`/`pi` → SVG, falls back to the `providerMeta` char for unknown. Used in model-picker (trigger + engine submenu), sidebar (per-session indicator), home-view ("connected" badges).

**Testing:** Vitest (jsdom + Testing Library) is wired — `bun run --filter @nuncio/web test` runs `vitest run`. Specs are co-located (`*.spec.tsx`): `utils`, `theme-provider`, `sidebar`, `App` (Sheet open), `home-view`, `model-picker`, `session-detail`, `status-dot`. jsdom gaps (`localStorage`, `matchMedia`, `ResizeObserver`, `Element.scrollIntoView`) are polyfilled in `src/test/setup.ts`. TDD-first applies end-to-end — write the failing spec, port the component, keep the suite green.

**Conventions:** `cn()` for class merging (no template-string concat). Icons via `lucide-react` with `data-icon="inline-start|inline-end"` inside `Button` (no manual sizing — components auto-size svgs). Use nova semantic utilities (`bg-background`, `text-muted-foreground`, `bg-card`, `border-border`, `bg-primary`) — never raw hex. shadcn primitives in `components/ui/` are CLI-generated; don't hand-edit unless fixing a primitive bug (the `sonner.tsx` `next-themes` → `@/components/theme-provider` swap is one such fix). Path alias `@/*` → `src` requires `baseUrl` + `ignoreDeprecations: "6.0"` in `tsconfig.app.json`/`tsconfig.json` so the shadcn CLI resolves `@/` (without it, `shadcn add` writes to a literal `@/` dir) and TS 6 stays happy.

## Bun runtime

Nuncio runs on **Bun** (≥ 1.3) — server, build, and tests. Bun replaces npm, jest, and node-as-runner.

**Why Bun:** faster install/test, one tool, no native-addon toolchain for SQLite (Pi SDK is even built with Bun upstream — good ecosystem signal).

**better-sqlite3 → bun:sqlite:** Bun blocks `better-sqlite3` at `dlopen` ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)), so the server uses the built-in `bun:sqlite`. `DatabaseService` does `require('bun:sqlite')` (tsc-friendly without bun-types; `db` typed `any`), opens `data/nuncio.db`, sets WAL via `db.exec('PRAGMA journal_mode = WAL')`. The repositories use the same `prepare/all/get/run` API. **One API difference:** `bun:sqlite` named params require a prefix in the object key (`{@id}`/`{$id}`), unlike better-sqlite3's unprefixed `{id}` — Nuncio uses **positional `?`** to avoid this; do not reintroduce named `@param` with unprefixed keys (it silently binds NULL under bun:sqlite).

**jest → bun test:** `jest`/`ts-jest` removed; tests run via `bun test`. `@types/jest` is kept for test-global typing (`bun test` is jest-API-compatible at runtime: `describe/it/expect/beforeAll/...`). Layout: `bun test test/unit/` (unit), `bun run test:e2e` (e2e over HTTP, mock provider), `bun run test:integration` (real-Pi, gated on `~/.pi/agent/auth.json`, opt-in — makes a real LLM call, 60s timeout).

**Scripts:** workspaces use `bun run --filter @nuncio/<pkg> <script>` (not npm `-w`). Server `dev`/`start` run TS directly on Bun (`bun --watch src/main.ts` / `bun src/main.ts`); `start:prod` is `bun run dist/main.js`. **Do not use `node dist/main`** — `bun:sqlite` only exists in the Bun runtime. `nest build` (tsc) stays for the `build` step (runtime-agnostic).

**Lockfile:** `bun.lock` (replaces `package-lock.json`).

**Trade-off:** the server requires Bun (loses Node portability). Verified on `cursor/bun-migration`: `bun install`, `bun test` (unit + e2e), `bun run build` (server + web PWA), `bun run lint`, and boot smoke (`bun src/main.ts` → `/api/health` + `/api/sessions`; WAL DB created). Pi-under-Bun (real LLM via `test:integration`) is the one path not yet exercised.

## Design principles (non-negotiable)

- **TDD-first.** Write the failing test first; implement only what makes it pass; never call work done on a red suite, and never weaken a test to pass the build. See [Working practice: TDD-first](#working-practice-tdd-first).
- **Async-first, not realtime chat.** Sessions are delegated background tasks; optimize for "delegate and review later," not "chat back and forth."
- **In-process agent, not subprocess.** One Bun process hosts many agent sessions (today Pi `AgentSession`s sharing `ModelRegistry`/`AuthStorage`; tomorrow each provider manages its own). Simpler and faster than spawning a CLI per session. Acceptable trade-off: one crash kills active sessions (personal scale, 3–5 concurrent, SQLite recovers).
- **Provider-agnostic harness.** Pi SDK is the inaugural provider, not the architecture. New agent SDKs (Cursor, OpenAI/Claude agents, …) implement the same `AgentProvider` contract and register — no session-layer or UI-layer changes to adopt them.
- **3-layer state decoupling** — conversation durable, agent loop disposable, machine state a strict FSM.
- **YAGNI / KISS / DRY.** Don't build ahead of the roadmap. The agent-provider abstraction is the one forward-looking investment, because the whole point is multi-SDK support.
- **Docs stay in sync with code.** After every implementation, update `README.md` (commands/API/architecture/status) and `AGENTS.md` if conventions shifted — stale docs count as unfinished work.
- **TL;DR when asking the user.** When you need a decision, lead with a one-line recommendation, then the trade-off (gain vs. loss) in one sentence, then the options. The user decides fast — don't bury the ask.

## Gotchas

- `bun run build --filter @nuncio/server` can hit `ENOTEMPTY` on `dist/` — remove `apps/server/dist` and retry.
- **Server requires Bun** — `bun:sqlite` is a Bun builtin, so `node dist/main` won't work. Always run via `bun` (`bun src/main.ts`, `bun run start:prod`).
- **bun:sqlite named params need a prefix** (`{@id}`/`{$id}`), unlike better-sqlite3's `{id}`. Nuncio uses positional `?` everywhere — don't reintroduce named `@param` with unprefixed object keys (silently binds NULL).
- No DB migration framework — any schema change needs a guarded `ALTER TABLE` for existing dev DBs (the `provider` column migration in `DatabaseService.migrate()` is the template: `PRAGMA table_info(...)` check → `ALTER TABLE`).
- Pi's `tools: ['read','bash','grep','find','ls']` are hardcoded in `createPiSession()` — not yet configurable per session or via env.
- Pi uses `SessionManager.inMemory(cwd)` when a workspace is set (else plain `inMemory()`) — active Pi sessions are lost on server restart; a `steer` on a revived session creates a fresh Pi session in the same worktree cwd (conversation history is in the event log, not restored into Pi). File-backed `SessionManager.create(cwd)` revive is not yet implemented.
- **Git worktrees:** each session with `projectPath` gets an isolated worktree at `NUNCIO_WORKSPACES_DIR/<sessionId>` on branch `nuncio/<id>-<slug>` branched from the picked base. Archive keeps the worktree + branch (no auto-cleanup yet). Worktree creation fails the HTTP create if git errors — no orphan session row.
- **Pi tool cwd vs. local extensions:** when `context.cwd` is set, `PiAgentProvider` passes `customTools` covering ALL built-in tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`, each `pi.createXTool(cwd)`) to `createAgentSession`. This is required because local Pi extensions (e.g. `claude-studio` in `~/.pi/agent/extensions/`) can `pi.registerTool({ name: 'bash', ... })` and override the built-ins — and `claude-studio` binds them to `process.cwd()` (the server's cwd) at extension load time, which would make the agent operate in the server dir instead of the worktree. SDK `customTools` take precedence over extension `pi.registerTool` overrides (verified in `pi-agent.cwd.spec.ts` + real-Pi `pi-agent.integration.spec.ts`). All built-ins are rebound (not just the active `tools` allowlist) so the allowlist can evolve without drift — an inactive customTool is filtered by the allowlist, but a cwd-correct instance is always ready. When no worktree, `customTools` is omitted so extension overrides apply as-is.
- **Project discovery:** set `NUNCIO_PROJECT_ROOTS=~/code,~/Desktop/Oscar` (comma-separated) for a quick-access list in the project picker. The picker also offers a **folder browser** ("Browse folders…") that navigates the host machine via `GET /api/fs/dirs` (server-side, since browsers cannot expose host filesystem paths — the iPhone PWA cannot use the File System Access API). A "Custom path…" paste option remains for power users. Browsers cannot browse the Mac filesystem directly (Tailscale iPhone PWA) — browsing is server-driven.
- iPhone PWA install needs HTTPS (Tailscale); plain `http://localhost` won't offer a full install.
- `vite preview` proxies `/api` → 3000, so a single `tailscale serve --bg 5173` is usually enough. Serving web + API from separate origins needs a reverse proxy.
- Don't bake Pi-specific assumptions (auth path, `ModelRegistry`, `streamingBehavior`) into `SessionsService` or the UI — route them through the provider. Adding a second provider is the test of whether the abstraction holds.
- shadcn primitives live in `components/ui/` and are CLI-generated — don't hand-edit them unless fixing a primitive bug; compose them in feature components. Use `cn()` for conditional classes, not string concatenation.
- **Cursor SDK under Bun** requires two escape hatches on every `Agent.create`: `local.useHttp1ForAgent: true` (Bun HTTP/2 client lacks bidirectional streaming → `NGHTTP2_FRAME_SIZE_ERROR` without it) and `local.store: new JsonlLocalAgentStore(<string dir>)` (default `SqliteLocalAgentStore` uses `node:sqlite`, not implemented in Bun 1.3.x). Constructor takes a **string** dir, not `{ dir }`. Smoke probe 2026-06-27 confirmed both work. Gated `test:integration` (`cursor-agent.integration.spec.ts`) is the canary. `Agent.create` is async (returns Promise) and hits backend immediately to validate the key — `isAvailable()` must NOT call it. SDK prints code-frame lines to stderr on errors — not suppressible via `Cursor.configure`.
- **Cursor token streaming uses `onDelta`, not `run.stream()`** — `agent.send(text, { onDelta })` fires `InteractionUpdate` callbacks (`text-delta` token-by-token, `tool-call-started`/`completed`) which the provider maps to `assistant_delta`/`tool_start`/`tool_end`. `run.wait()` drains the run and returns the terminal `result.result` for the final `assistant_message`. Do NOT iterate `run.stream()` for text (block-level `assistant` events) when `onDelta` is wired — that would double-emit deltas.
- **Cursor NGHTTP2 rejections can crash Bun** — the SDK's Connect-Node HTTP/2 client emits stray `NGHTTP2_FRAME_SIZE_ERROR` / `ERR_HTTP2_STREAM_ERROR` rejections (from model discovery / `Agent.create` validation) that escape the provider's try/catch (they fire async on the stream 'error' event, not via the async iterator). Bun exits on unhandled rejections (unlike Node). `main.ts` installs `unhandledRejection` / `uncaughtException` handlers that swallow the known transient Cursor HTTP/2 variety and `process.exit(1)` on real bugs — keep them. The `dev` script's `bun --watch` also reloads on `data/nuncio.db-wal` / `data/cursor-store/` writes, which kills the in-memory Cursor agent handle mid-run → hung session; for Cursor testing run the server with `start` (`bun src/main.ts`, no `--watch`) instead of `dev`.

## Reference projects (consult when stuck)

Similar products worth reading when blocked on a pattern Nuncio needs. **Read for approach — don't copy blindly; Nuncio's constraints differ** (self-hosted, Tailscale, async-first, in-process Pi, PWA, Bun).

### Synara — https://github.com/Emanuele-web04/synara
Local-first desktop app for coding with AI agents you already pay for. **Closest analog to Nuncio's direction.**
- **Multi-provider orchestration:** supports Claude Code, Codex, Gemini, OpenCode, Cursor, Grok, Kilo Code, and **Pi** — a working reference for Nuncio's `AgentProvider` vision. Notably does **hand-off a thread to another provider with the same context** (relevant once Nuncio adds a second real provider).
- **Git worktree per thread** — reference for Nuncio's Phase 4 (workspace/branch/PR per session).
- **Runs on Bun** (`bun install` / `bun run dev`) — a shipping example of a similar app on Bun; useful evidence for the Bun runtime, especially around native modules and Pi under Bun.
- Local-first, talks directly to providers — same privacy posture as Nuncio.

### T3Code — https://github.com/pingdotgg/t3code
Minimal web GUI for coding agents (Codex, Claude, Cursor, OpenCode). Synara forked from this.
- **`docs/` is the prize:** `docs/architecture/overview.md`, `docs/providers/*.md` (codex/claude/cursor/opencode), `docs/reference/encyclopedia.md` — read these for provider-integration patterns and web-GUI-for-agents architecture when designing Nuncio's provider layer or UI.
- `npx t3@latest` run-without-installing distribution — a different model than Nuncio's self-host, but worth knowing as a contrast.

### When to consult which
- Stuck on **multi-provider / per-session provider / provider hand-off** → Synara + T3Code provider docs.
- Stuck on **Phase 4 git workspace/worktree/PR** → Synara.
- Stuck on **Bun runtime (native modules, Pi under Bun)** → Synara (ships on Bun).
- Stuck on **web-GUI-for-agents architecture** → T3Code `docs/architecture/overview.md`.
- Add more references here as they're discovered.
