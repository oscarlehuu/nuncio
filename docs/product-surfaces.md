# Product Surfaces

Capability → every place it appears. Agents read this **before** changing UI or a
cross-cutting feature. When a change conflicts with this map, update the map in the
same PR — a merged change with a stale surface matrix is unfinished work.

Companion docs:

- Why: [`product-vision.md`](product-vision.md)
- Locked decisions: [`architecture-decisions.md`](architecture-decisions.md)
- Internals: [`system-architecture.md`](system-architecture.md)
- Verify: [`testing-and-verification.md`](testing-and-verification.md)

## How to use this doc

1. Find the **capability** you are changing (not the screen name).
2. Touch **every sibling surface** in that row (web + mobile + settings + server as listed).
3. Prefer shared **leaves** (`ModelPicker`, `Transcript`, pickers) over editing one shell and
   forgetting the other.
4. Multi-fidelity is intentional (full session vs grid tile vs mobile). Do **not** merge routes
   to “fix” fragmentation — share logic, keep shells.

## Mental model

```text
Capability (domain)          ← think here first
  └─ Shared leaf / contract   ← ModelPicker, transcript core, derive-verify-status, APIs
  └─ Shells (screens)        ← Home, Workbench slot, Session detail, Mobile, Settings section
```

Backend modules under `apps/server/src/<domain>/` are already domain-oriented. Frontend files
are often **screen-named** (`home-view`, `grid-slot-composer`, `session-detail`). That naming
does **not** mean the capability is unique to that file.

---

## Route map (current)

### Web (`apps/web/src/App.tsx`)

| Route | Surface | Canonical entry |
|---|---|---|
| `/` | **Home** — composer + digest + attention + recent Crew | `home-surface.tsx` → `home-view.tsx` |
| `/grid` | **Workbench** — multi-session grid | `grid-view.tsx` |
| `/session/:sessionId` | **Session detail** — transcript + steer + inspector dock | `session-detail.tsx` |
| `/crew/:taskId` | **Crew task / run** | `crew/crew-task-detail.tsx` |
| `/autopilot/*` | **Autopilot / loops** | `autopilot-routes.tsx` |
| `/settings` | **Settings** (`?section=`) | `settings-view.tsx` |
| `/digest` | Digest detail | `digest-view.tsx` |
| `/timeline` | Global activity | `timeline-view.tsx` |
| `/forge/pr` | Standalone PR deep link | `forge/standalone-pr-route.tsx` |
| `/changelog` | What's new | `changelog-view.tsx` |
| `/new` | Redirect → `/` | legacy |
| `/board` | Redirect → `/grid` | legacy |
| `/inbox` | Redirect → `/` | attention lives on Home |

### Mobile (`apps/mobile/src/app/`)

| Route | Surface |
|---|---|
| `/` | Session list + Crew rows |
| `/new` | Create Solo / Crew |
| `/session/[id]` | Transcript + steer |
| `/crew/[taskId]` | Crew task / run |
| `/pairing` | Tailscale URL + Bearer pairing |

Mobile has **no** Workbench, Autopilot, Settings shell, Forge dock, File explorer, Terminal, or Browser.

### Desktop

Electron (`apps/desktop`) wraps the same web UI. Browser dock and `node-pty` terminal are
desktop-capable; web/PWA uses WS terminal and does **not** expose the browser dock. The shell also
persists normal window bounds plus maximized state under Electron `userData`, revalidating them
against the current display work area whenever it creates a window.

---

## Capability matrix

Columns: **Web** = primary components / routes · **Mobile** · **Settings** · **Server** ·
**When you change X, also check**.

### New-session composer (create agent)

| | |
|---|---|
| **Web** | Home: `home-view.tsx` (scope `home:new-agent`) + optional `mcp-server-chip-picker.tsx` per-session MCP override. Workbench empty slot: `grid-slot-composer.tsx` (scope `workbench-slot:N`, default `workbench:new-agent`). Shared leaves: `model-picker.tsx`, `project-picker.tsx`, `branch-picker.tsx`, `workspace-mode-picker.tsx`, `session-mode-picker.tsx` (Home only; capability-gated on `capabilities.modes`), `attachment-tray.tsx`, `use-composer-attachments.ts`. |
| **Mobile** | `apps/mobile/src/app/new.tsx` |
| **Settings** | Providers / Projects defaults affect create; not the composer UI itself |
| **Server** | `POST /api/sessions` (`mode?`), `sessions/`, `models/`, `git/`, `projects/`; per-mode prompt overlay in `sessions/domain/session-modes.ts` |
| **Also check** | Both Home **and** Workbench composers; mobile `/new` if create UX changes; Crew create only on Home + mobile (Workbench has **no** Crew path today); hub machine picker on Workbench slots **and** Home Crew create (routes the run to the chosen machine, which then owns it) |
| **Prefs** | `packages/core/src/model-preference.ts` — scoped keys above |

### Steer / chat input (existing session)

| | |
|---|---|
| **Web** | Full: `session-detail.tsx`. Compact tile: `session-tile.tsx` (Workbench). Maximized grid slot remounts full `SessionDetail`. |
| **Mobile** | `apps/mobile/src/app/session/[id].tsx` |
| **Server** | `POST /api/sessions/:id/steer`, WS relay `steer`, `steer_queue` |
| **Also check** | Detail + tile (+ mobile) for send/lock/queue/attachment/interrupt behavior; do not assume tile has full fidelity |

### Transcript / streaming

| | |
|---|---|
| **Web** | `session-transcript.tsx`, `transcript-blocks/*`, grid via `session-tile.tsx` |
| **Mobile** | `transcript-block-view` + session screen |
| **Shared** | `@nuncio/core` transcript build blocks; `session-relay-client`; web `use-session-stream.ts` |
| **Server** | `events` log, `/api/sessions/ws`, SSE for API consumers |
| **Also check** | Core parser first; then web + mobile renderers |

### Model selection

| | |
|---|---|
| **Web** | `model-picker.tsx` on Home composer, Workbench slot composer, Autopilot `create-loop-dialog` / loop settings, Crew profile dialogs, `subagent-row`, Settings Agents / subagent models |
| **Mobile** | `/new` only |
| **Settings** | Providers (Cursor / Nuncio Engine / Claude / Codex / Devin rows), Agents (subagent models), Usage. Default solo permission/runtime modes: Claude `NUNCIO_CLAUDE_PERMISSION_MODE`, Codex `NUNCIO_CODEX_RUNTIME_MODE`, Devin `NUNCIO_DEVIN_PERMISSION_MODE` (Pi has no permission mode). |
| **Server** | `models/`, provider `listModels()`, `usage/`, settings registry keys above |
| **Also check** | Every picker host that should inherit catalog/effort/fast UX — not only Home; Providers pane must list Claude + Devin (not search-only) |

### Crew

| | |
|---|---|
| **Web** | Create: Home `use-crew-composer.ts` + `execution-mode-picker.tsx`, plus `crew/crew-machine-picker.tsx` to route the run to a tailnet machine (which then owns it end to end). Detail: `/crew/:taskId`, or `/m/<machine>/crew/:taskId` for a run owned by another machine → `crew/*`. Recent: `recent-crew-runs.tsx` on Home (local runs only). Profiles: Settings → Crew profiles |
| **Mobile** | Create on `/new`; detail `/crew/[taskId]` |
| **Settings** | `crew-profiles` |
| **Server** | `crew/` (see [`crew-workspace-harness.md`](crew-workspace-harness.md)); unchanged for hub routing — the owning machine serves the full Crew API under `/m/<machine>/` |
| **Also check** | Web create + Settings profiles + mobile create/detail; hub-routed create (Home machine picker → full nav to `/m/<machine>/crew/:taskId`) keeps every locked invariant on the owning machine (ADR-013); remote runs raise attention on that machine, not Home; member sessions stay readable but not publicly mutable |

### Autopilot / loops

| | |
|---|---|
| **Web** | `/autopilot/*` — `autopilot-view.tsx`, `loop-detail-view.tsx`, `loop-run-detail-view.tsx`, `global-runs-view.tsx`, `create-loop-dialog.tsx` |
| **Mobile** | None (may surface via attention / push only) |
| **Settings** | Projects (per-project loop / verify defaults) |
| **Server** | `loops/`, `scheduler/`, ties to `tasks/`, `projects/`, attention breakers |
| **Also check** | Autopilot UI + Projects settings + scheduler/attention collectors (+ MCP loop tools if applicable) |

### Attention / digest / timeline

| | |
|---|---|
| **Web** | Home embedded: `attention-queue.tsx`, `digest-card.tsx`. Full: `/digest`, `/timeline`. Sidebar badge. Routing kinds: `lib/attention-kind.ts` |
| **Mobile** | Push deep-links to session/crew — no full inbox UI |
| **Server** | `attention/`, `attention/heartbeat/`, `attention/fleet/`, `dispatcher/`, `observability/` |
| **Also check** | Home queue + digest/timeline + collectors; dispatcher approvals are **attention rows**, not a `/dispatcher` route |
| **Legacy** | `inbox-view.tsx` is **not routed** (`/inbox` → `/`). Do not revive without updating this doc |

### Forge / SCM / PR

| | |
|---|---|
| **Web** | Session inspector: `forge/scm-panel.tsx` (live path — Changes / PR / issues). Standalone: `/forge/pr` → `standalone-pr-route.tsx` + `pr-detail.tsx`. PR Conversation tab loads `GET /api/forge/pulls/:number/comments` (full issue-style thread) plus review threads; markdown renders images (`ChatImage`) and mp4/webm/mov links (`ChatVideo`), unwrapping GitHub `<details>` wrappers. Project picker may browse/clone. Attention can deep-link PR review |
| **Mobile** | None; forge automation is backend-only |
| **Settings** | Source control (GitHub / GitLab) + Advanced automation toggles `forges.autoSteer` and `forges.autoCloseOnMerge` (both default true; env fallbacks `NUNCIO_FORGES_AUTO_STEER` / `NUNCIO_FORGES_AUTO_CLOSE_ON_MERGE`) |
| **Server** | `forges/` (incl. `GET /api/forge/pulls/:number/comments` via `listPullRequestComments`), `git/` (`sync`, `unpushed`, `commits/:sha/diff`, `stash`, `blame`, `history`, `pull`, status/diff/push), `POST /api/sessions/from-pr`, signed forge webhooks, session git/PR routes. GitHub normalizes reviews, review comments, PR issue comments, failed workflow/check runs, and PR close; GitLab normalizes MR notes, failed associated pipelines, and MR merge/close. Feedback auto-steers only for repository writers and never for the connected forge login; untrusted/unverifiable authors and missing owners raise `pr-feedback` Attention. Feedback and CI are durably queued before the webhook returns `202`; background delivery failures also raise Attention. PR adoption atomically reuses one active owner and configures plain pushes to the PR source. A merged owner is archived and its worktree removed only when IDLE, clean, and without unpushed commits; every failed gate skips cleanup non-destructively and raises Attention. |
| **Also check** | Settings credentials/automation toggles + live `scm-panel` + standalone PR + `pr-review`/`pr-feedback` attention items |
| **Legacy** | `review-changes.tsx` is unwired orphan; prefer `scm-panel` / `session-changes-panel`. Do not “fix PR UI” only in orphans |

### Verify / auto-fix / diff / evidence

| | |
|---|---|
| **Web** | `verify-chip.tsx`, transcript `verify-rows`, `session-changes-panel.tsx`, `edit-project-config-dialog.tsx`, Crew `crew-gates.tsx`, Autopilot run detail |
| **Shared** | `derive-verify-status.ts` (and related helpers) |
| **Settings** | Projects (verify command / policy); Agents: `NUNCIO_EVIDENCE_URL` (green-verify auto-evidence fallback); Providers → Nuncio Engine: `NUNCIO_ENGINE_GATE_GUARD` (blocks agent writes to `.nuncio/`) |
| **Server** | sessions verify/diff (`diff/turn-diff-classifier.ts` skip-on-clean fingerprint + file classes), `evidence/` (+ `SessionsService.captureVerifyEvidence` auto-capture, `pi-engine/capture-evidence-tool.ts`), `pi-engine/gate-integrity.ts` + `engine-extension.ts`, Crew verifier, loop verify |
| **Also check** | Settings/projects + session/tile chips + transcript (incl. evidence blocks) + Crew gates + loop run detail |

### Tasks / subagents / multitask

| | |
|---|---|
| **Web** | Composer multitask affordances; session `subagents-panel.tsx` (live "N working" footer), `subagent-row.tsx`; parent transcript board via `transcript-blocks/task-digest-card.tsx` + lineage chips in `session-detail.tsx` |
| **Settings** | Agents → subagent models; `NUNCIO_MULTITASK_MAX_SUBTASKS` (2–5 cap), `NUNCIO_MULTITASK_COUNTDOWN_SECONDS` (launch grace) |
| **Server** | `tasks/` — `startMultitask` fan-out + `multitask-coordinator.service.ts` (decompose → announce → fan-out → wait on children), `multitask-board.ts` projection. A multitask-mode parent whose engine implements `AgentProvider.decompose` (capability-gated on `capabilities.modes`) runs a coordinating turn instead of a normal agent turn: RUNNING until every child settles or the parent detaches. An engine WITHOUT `decompose` falls back to a normal run with the multitask prompt overlay. |
| **Also check** | Session panel + Settings model overrides + create-with-`mode: 'multitask'`; the `/multitask <prompt>` steer path still fans a single prompt out manually; child model must equal the parent's (no silent swap) |

### Session inspector dock

| Tool | Web component | Notes |
|---|---|---|
| SCM / Changes / PR | `forge/scm-panel.tsx`, `session-changes-panel.tsx` (+ branch sync, outgoing/incoming, stash, blame, history, issues via `GET/POST /sessions/:id/git/*`) | See Forge row |
| Files | `file-explorer-panel.tsx` | Server `fs/` |
| Terminal | `terminal-dock.tsx` / `terminal-panel.tsx` | Server `terminal/`; desktop IPC or WS |
| Browser | `browser-panel.tsx` + `design-mode-overlay.tsx` | Desktop-only. **Design Mode**: page highlight/click inject + Cursor-style **pill composer** in React under the BrowserView (cannot paint over native view / CSP sites). Steers open session only. Restart Desktop after code pulls. |
| Subagents | `subagents-panel.tsx` | See Tasks row |
| Queued steers | `queued-steers-panel.tsx` | Session detail |

Prefs: `inspector-preference.ts`. Changing dock chrome usually stays in `session-detail.tsx`;
changing a **tool** means the panel + its server module.

### Hub / multi-machine

| | |
|---|---|
| **Web** | Workbench slots: hub machine picker in `grid-slot-composer.tsx`. Home Crew create: `crew/crew-machine-picker.tsx` (routes a run to the owning machine). Shared: `remote-session-tile.tsx`, `machine-switcher.tsx`, `lib/hub-api.ts` (`machineApiBase` is the per-call base seam) |
| **Mobile** | Pairing / connection store (not full hub grid) |
| **Settings** | Remote access |
| **Server** | `hub/`, `relay/`, `pairing/`, `devices/`, `auth/` |
| **Also check** | Grid hub UX + Home Crew machine routing + remote access settings + pairing/auth |

### Handoff (Continue on mobile)

| | |
|---|---|
| **Web** | `handoff-picker.tsx` — opened from Home and session header (`App.tsx`) |
| **Mobile** | Consumes imported sessions after pairing |
| **Server** | `cursor-local/`, `pi-local/`, `POST /api/sessions/handoff` |
| **Also check** | Both entry points + import APIs |

### External agent memories (Nuncio Engine)

Read-only Claude Code / Codex CLI memories indexed into Pi sessions; stores stay in place.

| | |
|---|---|
| **Settings** | Providers → Nuncio Engine: `PI_EXTERNAL_MEMORIES` (off/claude/codex/all), `PI_EXTERNAL_MEMORIES_MAX_BYTES`, `NUNCIO_CLAUDE_CONFIG_DIR` (+ shared `NUNCIO_CODEX_HOME`) |
| **Server** | `agents/pi-engine/external-memor*` (sources, budgeted index, `read_external_memory` tool), wired in `pi-agent.provider.ts` |
| **Also check** | Honors Claude `autoMemoryDirectory` and inherited `CODEX_HOME`; no web/mobile shell — the surface is the injected system-prompt block + tool |

### Settings taxonomy

`/settings?section=<id>` — `settings-view.tsx`:

| Section id | Owns |
|---|---|
| `general` | General |
| `appearance` | Theme / chat font / density (client) |
| `providers` | Engine credentials + updates |
| `usage` | Quotas / history charts |
| `source-control` | GitHub / GitLab |
| `mcp-tools` | MCP & tools — MCP Store rows (import, enable/disable, lazy/full advertise, OAuth Connect/Reconnect for remote servers, remove) + tool defaults |
| `agents` | Agent / subagent model prefs |
| `crew-profiles` | Crew profiles |
| `workspaces` | Workspace roots / worktree dirs |
| `projects` | Per-project defaults (verify, default MCP servers, loops, …) |
| `remote-access` | Tailscale / pairing / remote |
| `advanced` | Advanced |

Server: `settings/`, `preferences/`, plus domain modules each section configures.

### Auth / pairing / push

| | |
|---|---|
| **Web** | `auth-gate.tsx`, Settings → Remote access, `pair-qr.tsx` |
| **Mobile** | `/pairing`, push registration on index |
| **Server** | `auth/`, `pairing/`, `devices/`, `push/` |

---

## Sibling checklists (copy into PR / agent prompt)

Use these literally when the change touches that capability:

- **Composer / create UX:** `home-view.tsx` + `grid-slot-composer.tsx` (+ mobile `new.tsx` if create flow)
- **Steer / composer lock / attachments on run:** `session-detail.tsx` + `session-tile.tsx` (+ mobile session)
- **Model picker behavior:** `model-picker.tsx` first, then every host that embeds it (Home, Workbench, loops, Crew profiles, subagents, Settings)
- **Forge / PR / changes:** Settings source-control + `forge/scm-panel.tsx` + `/forge/pr` (+ attention PR kinds). Skip orphans unless deleting them
- **Verify:** Projects settings + chips + transcript rows + Crew gates + Autopilot run detail
- **Attention item kinds:** collectors (server) + `attention-row` actions + Home queue (+ digest/timeline if presentation)
- **Loops:** `/autopilot/*` + Settings Projects + `loops/`/`scheduler/` (+ attention breakers)
- **Crew:** Home create + `/crew/:taskId` + Settings crew-profiles + mobile create/detail

---

## Intentionally multi-fidelity (do not “unify” by deleting)

| Pair | Why both exist |
|---|---|
| Home composer vs Workbench slot composer | Home = delegate cockpit (Crew). Workbench = per-slot create + hub/attach |
| Session detail vs session tile | Full review vs dense monitoring |
| Web vs mobile | Phone is thin client: list / create / steer / crew — not Workbench/Settings/Forge dock |
| Desktop browser dock vs web | Browser dock is desktop-only by product decision |

---

## Orphans / ghost surfaces (do not treat as live product)

| Path | Status |
|---|---|
| `inbox-view.tsx` | Not routed; `/inbox` → Home |
| `review-changes.tsx` | Unwired; live SCM is `scm-panel` / `session-changes-panel` |
| `/new`, `/board`, `/inbox` | Redirects only |
| `home-view` `embedded` prop | Declared; no current caller — confirm before building on it |
| Docs mentioning `fleet-view.tsx` as Home UI | Stale — Home is `home-surface` / composer + digest + attention. Fleet remains a **server/data** concern under `attention/fleet/` |

---

## Server domain → primary UI (quick index)

| Server module | Primary UI |
|---|---|
| `sessions/`, `agents/`, `models/` | Home, Workbench, Session, Mobile |
| `crew/` | Home create, `/crew/*`, Settings crew-profiles, Mobile |
| `loops/`, `scheduler/` | `/autopilot/*`, Settings projects |
| `attention/`, `dispatcher/`, `observability/` | Home queue, `/digest`, `/timeline`, push |
| `forges/`, `git/` | Settings source-control, session SCM, `/forge/pr` |
| `tasks/` | Multitask / subagents panel |
| `terminal/`, `browser/`, `fs/`, `evidence/` | Session inspector dock |
| `hub/`, `relay/`, `pairing/`, `devices/`, `push/` | Workbench hub, Remote access, Mobile pairing |
| `settings/`, `preferences/`, `projects/`, `usage/` | Settings sections |
| `mcp-stdio/` | Separate `bun run mcp` entry — see [`nuncio-mcp.md`](nuncio-mcp.md) |

---

## Maintaining this doc

Update this file in the **same PR** when you:

- Add/remove/rename a route or Settings section
- Add a second shell for an existing capability
- Wire or delete an orphan
- Change mobile parity for a domain

Do not wait for a “docs cleanup” pass — stale surface maps are how agents miss siblings.
