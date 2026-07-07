# Phase 2 — Autopilot (Rung 2)

**Status:** Design + red suite for sub-phase A (2026-07-07). Scheduler and loop primitive are later
sub-phases; this doc is the rung-2 master plan plus the sub-phase A (project entity) design.
**Depends on:** Rung 1 (verify-feedback loop, shipped) — loops reuse the task lane + verify loop.
**North-star:** plan.md rung-2 row + proposals table; design material in
[cockpit-map.md](./cockpit-map.md) (Rung 2 section).

## Goal

Turn nuncio from a task runner into an autopilot: standing **loops** (`{goal, trigger, budget, stop,
escalation}`) fired by cron / forge webhooks / heartbeat, each scoped to a first-class **project**,
running inside **budgets & breakers**, landing output via worktree + PR. Done when one maintenance
loop runs nightly for a week, inside budget, all output via PR.

## What already exists (scout — extend, don't duplicate)

- **No project CONFIG entity.** "Project" today is (a) a free `project_path` string on `sessions`
  and `tasks`, and (b) a lightweight `recent_projects` MRU table (`path, name, last_used_at`) driving
  the picker (`git/recent-projects.repository.ts`, `/projects` controller). The sidebar "group by
  repository" is derived **purely from `session.projectPath`** with the name from the path basename
  (`apps/web/src/lib/group-sessions.ts`, `projectDisplayName`). There is nowhere to hang per-project
  config (default engine, worktree policy, verify override).
- **Tasks lane + runner** exist (`tasks.*`), FIFO with concurrency, worktree-per-task optional.
- **Forge webhooks** normalize vocabulary per ADR-005 (`forges/webhooks/`), with a
  `forge_webhook_deliveries` dedup table — the event-trigger substrate is already here.
- **Settings** resolve DB → env → default (`SettingsService.resolve`); verify command resolves
  `.nuncio/verify` → `NUNCIO_VERIFY_COMMAND` (`session-verifier.ts`).
- **Migrations** are guarded `PRAGMA table_info` + `CREATE TABLE IF NOT EXISTS` in
  `DatabaseService.migrate()` (ADR-006).

**Design consequence:** sub-phase A adds a `projects` CONFIG table keyed by path — the config layer
the loop primitive and rung-3 fleet view both need. `recent_projects` stays the MRU picker;
`project_path` on sessions/tasks becomes a **soft reference** (by path) into `projects` — never a hard
FK, so a session whose project has no config row still works (falls through to global defaults).

## Sub-phase breakdown (dependency order)

**A. Project entity** (this task's design + red tests) → **B. Scheduler** → **C. Loop primitive**.

- **A — Project entity.** A `projects` config record keyed by path: name, default engine, worktree
  policy, verify-command override (v1 fields — see decision table). Per-project defaults resolution
  layered above global settings. This is the base every loop and the fleet view stand on: a loop is
  *scoped to a project*, and its worktree/engine/verify come from the project's config.
- **B — Scheduler.** A daemon-resident, restart-safe scheduler: cron ticks + forge-webhook events +
  heartbeat, each firing a trigger. State (schedules, next-fire, last-fire) lives in SQLite and
  rebuilds at boot (no in-memory-only truth — restart test). Depends on A because a scheduled trigger
  enqueues a task *scoped to a project* (engine/worktree/verify come from the project config). The
  webhook substrate already exists; the scheduler adds the cron/heartbeat clock + a durable
  schedule table and wires webhook deliveries → trigger evaluation.
- **C — Loop primitive.** The 5-field record `{goal, trigger, budget, stop, escalation}` as a durable
  row, plus budgets/breakers (a breaker pauses a loop after N consecutive failed runs) and the
  webhook→loop wiring. A loop run is a task (rung 1) scoped to a project (A), fired by the scheduler
  (B). Output lands via worktree + PR. Depends on both A and B.

**Split justification / amendment vs the code:** the plan's A→B→C order holds. The scout confirms A is
genuinely missing (only a free string + MRU picker exist) and is a hard prerequisite — B's triggers
and C's loops both reference a project for their engine/worktree/verify defaults, and rung-3's fleet
view renders project rows. B is second because the webhook substrate is already present (so B is
mostly the cron/heartbeat clock + a durable schedule table, smaller than it looks) and C's triggers
need it. No re-ordering needed.

## Founder-decision table — LOCKED (founder, 2026-07-07)

All five locked as recommended, with ONE amendment: **(e) pulled into v1** — the project entity
ships with `verifyAutoSteer` (tri-state on/off/inherit) and `verifyMaxRounds` (nullable) from the
start, so v1 has **7 fields**, and the verify-feedback loop resolves per-project overrides above
the global setting. Original table:

| # | Decision | Recommendation | Rationale |
|---|----------|----------------|-----------|
| a | **Budget semantics v1** | **Run-count based**: `maxRunsPerDay` + `maxConsecutiveFailures`. Defer token/cost budgets to rung 4. | Token/cost tracking does not exist yet (rung 4 observability). A run-count budget is measurable *today* from the tasks table, is restart-safe (count durable rows), and still delivers the core safety property (a loop can't run away). Token ceilings layer on cleanly once rung 4 writes cost data — no schema rework, just an added budget dimension. |
| b | **Loop write policy** | **Always worktree + PR, never a direct branch write.** | Matches plan.md proposal. A standing unattended loop writing to a shared branch is how an overnight run corrupts main. Worktree isolates; PR is the founder's one-tap review surface (rung 3). Worktree-per-task already exists, so this is a policy default on the loop, not new plumbing. |
| c | **Breaker defaults** | **Pause the loop after 3 consecutive failed runs; emit a needs-attention signal** (reuse rung-1's `verify_needs_attention` shape / the rung-3 attention queue seam). | 3 consecutive failures = the loop is stuck, not flaky. Pausing (not deleting) preserves state for the founder to inspect/resume. Reuses the rung-1 surface so the attention queue has one vocabulary. |
| d | **Project entity field scope (v1)** | **v1:** `path` (key), `name` (override; else basename), `defaultEngine` (provider-neutral), `worktreePolicy` (`always`/`never`/`optional`), `verifyCommand` (override). **Deferred:** context-files management (AGENTS.md/context per repo — cockpit-map puts it in rung 3's fleet view, and it fails the phone test today), per-project budgets (ride the loop, not the project, until proven). | These five are exactly what a loop needs to run *and* what the fleet view displays. Context-file management is a bigger UX surface (rung 3). Keeping v1 to config a loop consumes avoids a fat entity. |
| e | **Per-project auto-steer override (rung-1 leftover)** | **Yes — ride the project entity, but as a v1.1 additive field, not v1.** Add `verifyAutoSteer` (tri-state: on/off/inherit) + `verifyMaxRounds` (nullable) to the projects table when the loop primitive (C) lands, since that's when per-project loop tuning first matters. v1 (this task) ships without them; the resolution *order* is designed to accept them. | Rung 1 shipped auto-steer as global-only with a founder note that per-project override "rides the project entity". It genuinely belongs here, but the projects entity should prove its resolution model on the 5 core fields first; adding the auto-steer override is a one-column, one-resolution-layer change once the pattern is proven. Flagged so the founder can pull it into v1 if desired. |

## Direction-test walk (product-vision.md — per sub-phase)

| Test | A (project entity) | B (scheduler) | C (loop primitive) |
|------|--------------------|--------------|--------------------|
| **Phone** | Project config edited from a settings-like screen; fleet view (rung 3) renders rows from it | Schedules viewable/pausable from phone (a loop's next-fire) | Loop create/pause/needs-attention all phone-actionable; PR review is the one-tap surface |
| **Engine** | `defaultEngine` is a provider-neutral string resolved through `AgentRegistry`; NO engine branch — an unknown engine is stored and flagged unavailable at resolve time | scheduler enqueues a normal task through the provider-agnostic runner | loop run is a task; engine comes from project config, zero engine branch (ADR-004) |
| **Forge** | project is forge-neutral (a path; PR target resolved via `ForgeProvider`) | webhook triggers already normalize GitHub/GitLab vocabulary (ADR-005) | PR landing goes through `ForgeProvider` — GitHub & GitLab both |
| **Restart** | projects table is durable SQLite; rebuilds at boot with no in-memory truth | schedule state (next-fire/last-fire) in SQLite, rebuilt at boot — a cron that forgets its schedule after reboot betrays pillar 4 | loop + breaker state durable; a mid-run restart reconciles like the task lane |
| **Self-host** | pure local SQLite, no cloud | cron clock is local; webhooks arrive over the tailnet | all output local worktrees + forge PRs via CLI creds |

## Sub-phase A design (project entity)

### Schema (ADR-006 — guarded, no migration framework)

New table, created in `DatabaseService.migrate()` via `CREATE TABLE IF NOT EXISTS` (idempotent, safe
every boot):

```sql
CREATE TABLE IF NOT EXISTS projects (
  path            TEXT PRIMARY KEY,     -- normalized absolute path; the identity
  name            TEXT NOT NULL,        -- explicit override or basename(path)
  default_engine  TEXT,                 -- provider-neutral id, or NULL = inherit global
  worktree_policy TEXT,                 -- 'always' | 'never' | 'optional' | NULL = inherit
  verify_command  TEXT,                 -- override, or NULL = inherit global/.nuncio/verify
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

- **Path is the identity** (PRIMARY KEY) — the same key sessions/tasks already carry as
  `project_path`. Upsert-by-path (`ON CONFLICT(path) DO UPDATE`) makes creation idempotent and dedups.
- Path is **normalized** on write (trim, collapse a trailing slash) so `/repo` and `/repo/` are one
  project. Empty/whitespace path is rejected at the boundary.
- Config fields are **nullable = inherit**: a project with only a path resolves to all-global
  defaults, so adding a config row is purely additive and backwards-compatible.
- No FK to sessions/tasks — the relationship is a **soft reference by path**. A session/task with a
  `project_path` that has no `projects` row is valid and resolves to global defaults (ADR-006 keeps
  the log/rows independent; a config row is not a lifecycle dependency).

### Relationship to existing "repository" grouping & `recent_projects`

- `recent_projects` stays the MRU **picker** (path/name/last_used, filtered by on-disk existence).
  It is orthogonal: recording a recent project does not create a config row, and creating a config
  row does not touch the MRU list. (Rung 3 may union them for the fleet view; not in scope here.)
- The web sidebar's repository grouping stays derived from `session.projectPath` and works unchanged.
  Once a `projects` row exists for a path, the group **name** can prefer the config `name` over the
  path basename — an additive enhancement, not a requirement for A.

### Per-project defaults — resolution order

A new `ProjectDefaultsResolver` (provider-agnostic) layers the project config **above** the existing
global chain, preserving today's behavior when no project row exists:

```
project override (projects row field, non-null)
  → global setting (SettingsService.resolve: DB → env → default)
    → registry default
```

- `verifyCommand`: project override → `.nuncio/verify` script → `NUNCIO_VERIFY_COMMAND` setting →
  none. (Slots the project override *above* today's `resolveVerifyCommand` chain.)
- `defaultEngine`: project → global default provider (`AgentRegistry.defaultId()`), resolved through
  the registry so an unknown engine is stored but reported unavailable — **no engine branch**.
- `worktreePolicy`: project → global (a new/optional global setting) → `optional` (today's implicit
  default: worktree-per-task is opt-in).

The resolution is a **pure function** of (project row | null, settings), so it is identical live and
after restart, and testable without a running provider.

### API surface

Extend the existing `/projects` controller (today only records recents):
- `GET /projects/config` — list all project config rows.
- `GET /projects/config?path=…` — one project's config (or 404).
- `PUT /projects/config` `{ path, name?, defaultEngine?, worktreePolicy?, verifyCommand? }` — upsert
  (create-or-patch by path); **patch semantics** — omitted fields are left unchanged, an explicit
  empty string clears an override.
- `DELETE /projects/config?path=…` — remove the config row (live sessions/tasks keep running; only
  the config is dropped).

(Exact controller wiring is sub-phase-A implementation; the red tests target the repository +
resolver contracts, which are the load-bearing pieces.)

### Restart / replay story

The `projects` table is plain durable SQLite — there is no event-log replay involved (it is config,
not conversation). A fresh module reads the same rows; resolution is a pure fold over (row, settings),
so no reconciliation is needed. The restart test asserts a second module instance sees every row
unchanged.

## Verify (for THIS task)

- Server specs under `apps/server/test/unit/projects/`:
  - `projects.repository.spec.ts` — create/dedup/normalize/validate/patch/list/delete/restart.
  - `project-defaults-resolver.spec.ts` — resolution order (project > global > env > default),
    unknown-project fallthrough, no-engine-branch.
- `bun test` runs them; RED for missing-feature (no `projects` table / repository / resolver), not
  syntax errors. Any pure invariants (e.g. "no projects row → global default") stay green only once
  the resolver exists — in this red phase they fail because the resolver is absent.
- `bun run --filter @nuncio/server lint` clean.

## Edge-case matrix

Full matrix in the task ledger
(`.claude/maestro/autopilot-project-entity/edge-cases.md`). Summary of must-survive cases: create,
dedup-by-path, path normalization, field validation (worktree policy enum, engine, verify override),
unknown-project soft-reference fallthrough, resolution order (4 layers), patch (unset ≠ null),
delete-with-live-sessions, list, restart rebuild, fresh-DB migration, recent_projects coexistence,
name override vs derived, missing-on-disk config allowed, all-optional fields.

## Founder decisions — resolved

Locked 2026-07-07 (see table above): run-count budgets (a), worktree+PR-only loop writes (b),
3-consecutive-failure breaker with manual resume (c), 7-field project entity v1 (d + e pulled in).
Sub-phase A implementation unblocked.

## Open conflicts

None found. The design fits existing invariants:
- **ADR-006:** guarded `CREATE TABLE IF NOT EXISTS`, no framework; config is not event-logged.
- **ADR-004:** `defaultEngine` resolves through `AgentRegistry`; zero engine branches.
- **ADR-005:** project is forge-neutral; PR targets go through `ForgeProvider`.
- **Soft-reference invariant:** no hard FK from sessions/tasks to projects, so a config row is never a
  lifecycle dependency — deleting a project cannot break a live session.
