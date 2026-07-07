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

## Sub-phase B design (scheduler) — design + red tests only (2026-07-07)

The scheduler is a **daemon-resident, restart-safe firing loop**: cron-like schedules + forge-webhook
event triggers + a heartbeat tick, each firing a **target** (v1 = enqueue a task from a template)
through the existing `TasksService`, so runner concurrency caps (`NUNCIO_TASK_CONCURRENCY`) still
apply. Personal scale — a single daemon timer scans due schedules; no distributed locking.

### Scout (what already exists — lean on it)

- **Webhook substrate already dedups deliveries.** `WebhooksService.recordDelivery`
  (`forges/webhooks/webhooks.service.ts`) does `INSERT OR IGNORE INTO forge_webhook_deliveries` and
  returns false on a replay — event triggers reuse this; the scheduler does **not** re-dedup.
  `ForgeWebhookEvent` carries `{provider, deliveryId, kind, action, owner, repo, labels, …}` — the
  exact fields an event filter needs.
- **`TasksService.enqueue(CreateTaskDto)`** is the fire seam (exported from `TasksModule`); a fired
  schedule enqueues a task, inheriting the FIFO pump + concurrency cap.
- **No injectable clock exists yet** — services call `Date.now()` directly. The scheduler introduces a
  tiny `Clock` seam (a settable `now()` — the repo's field-override test pattern) so next-fire and
  missed-fire are deterministic without hour-long sleeps.

### Durable schedule state (ADR-006)

Guarded `CREATE TABLE IF NOT EXISTS` in `DatabaseService.migrate()`:

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,        -- 'cron' | 'event' | 'heartbeat'
  spec          TEXT NOT NULL,        -- cron: the v1 spec string; event: JSON filter; heartbeat: interval
  target_json   TEXT NOT NULL,        -- what to fire (v1: a task template — a CreateTaskDto subset)
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_fire_at  INTEGER,              -- epoch ms; NULL for pure event triggers (fired by webhook, not clock)
  last_fire_at  INTEGER,
  last_result   TEXT,                 -- 'ok' | 'skipped-overlap' | 'missed' | 'error:<reason>'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

- **`target` is a seam, not just a task.** v1 `target_json` = `{ kind: 'task', template: <CreateTaskDto
  subset> }`. When C lands, a `{ kind: 'loop', loopId }` target rides the same column — the firing
  path branches on `target.kind`, and both flow through `TasksService`. No schema change for C.
- **Restart is the heart.** `next_fire_at` is **derived from `spec` + the clock at boot**, never
  trusted as in-memory truth: on module init the scheduler recomputes `next_fire_at` for every enabled
  cron/heartbeat schedule from its spec relative to `now`, so a cron that "forgets its schedule after
  reboot" (pillar 4 failure) is impossible. Event schedules have `next_fire_at = NULL` (they fire on
  webhook arrival, not on the clock).

### Cron spec v1 — LOCKED (founder, 2026-07-07): subset, no dependency

**Recommendation: a small parsed subset, NO dependency** —
`daily@HH:MM` · `every:<N>m` / `every:<N>h` · `<weekday>@HH:MM` (mon..sun). Rationale: cockpit-map's
loop families need only *nightly*, *interval*, and *webhook* triggers; full crontab syntax (`*/5 * * *
1-5`) needs a parser dependency (croner et al. — must be Bun-clean and is an ongoing maintenance
surface) for expressiveness v1 will not use. The subset is a ~40-line pure parser + next-fire
computer, fully unit-testable. **Flagged:** the founder may prefer full crontab via a vetted Bun-clean
dep — if so, swap the parser, the table/firing loop are unaffected. v1 is **timezone-naive**: `HH:MM`
is the injected clock's local frame; DST transitions are a documented v1 limitation (not handled).

### Missed-fire policy — LOCKED (founder, 2026-07-07): fire-once-on-boot with `missed` marker

**Recommendation: fire-once-on-boot when missed.** If the daemon was down when a schedule's
`next_fire_at` passed, on boot fire it exactly once (a maintenance loop should still run "tonight" even
if the machine was asleep at the scheduled minute), record `last_result = 'missed'` as the marker,
then advance to the next occurrence. **Flagged:** the alternative is skip-to-next (never fire late) —
correct for triggers where a late run is worse than a skipped one (e.g. a "good morning" digest at
noon is noise). Recommend fire-once because the rung-2 families (maintenance / overnight batch) want
the work done; a per-schedule `missedPolicy` field is a natural v1.1 if the founder wants both.

### Clock injection & the firing loop

- **`Clock`**: `{ now(): number }`, default `() => Date.now()`; the scheduler holds it as a settable
  field (test seam). Every time read — next-fire, due check, missed check — goes through it. Tests
  advance time by setting the clock and invoking the scan directly; **zero real sleeps**.
- **Firing loop**: one daemon timer (a single `setInterval`-like tick, itself gated by `destroyed`)
  runs `scanDue()`: select enabled cron/heartbeat schedules with `next_fire_at <= now`, fire each,
  advance its `next_fire_at`. Tests call `scanDue()` directly with a set clock — the timer is only the
  production driver.

### Event triggers (ADR-005 vocabulary)

- An event schedule is `kind='event'`, `spec` = a JSON filter `{ event: 'issue.opened', label?: 'agent'
  }` (`event` = `<kind>.<action>` from the normalized `ForgeWebhookEvent`). It has no `next_fire_at`.
- Firing is driven by the webhook path, not the clock: when a verified, **de-duplicated** delivery
  arrives (dedup already done by `forge_webhook_deliveries` — verified in the scout:
  `WebhooksService.recordDelivery` returns false on a replay), the scheduler matches it against
  enabled event schedules; each matching filter fires the same enqueue seam. The scheduler **must
  not** re-dedup — dedup is the webhook path's responsibility, so `handleWebhookEvent` is only invoked
  for unique deliveries. (Design contract, not a scheduler unit test, since re-dedup would be
  redundant; the wiring test that a replay does not reach the scheduler belongs with the
  webhook-scheduler integration when implementation lands.)
- Filter match: `event` equals `<kind>.<action>` AND (no `label`, or the label is in `event.labels`).

### Concurrency & safety

- **Overlap skip** (never overlap the SAME schedule): if a schedule's prior fire is still in flight
  when its next fire is due, skip with `last_result='skipped-overlap'` and advance — never two
  concurrent fires of one schedule. (Distinct schedules run independently, capped by the task runner.)
- **Shutdown mid-fire**: the firing loop is `destroyed`-gated and its DB writes flow through the
  repository funnel, which no-ops on `database.closed` (the rung-1 round-7 guard) — a fire enqueuing
  during shutdown never writes to a torn-down DB; a due fire not yet started is simply not started.
- **Fires go through `TasksService`**, so `NUNCIO_TASK_CONCURRENCY` caps total concurrent runs across
  all schedules — the scheduler adds no parallelism of its own.

### Direction-test walk (B)

Phone: schedules list/pause/next-fire viewable from the phone (rung-3 surface). Engine: a fired task
picks its engine from the project config (sub-phase A) through `AgentRegistry` — no engine branch.
Forge: event triggers already normalize GitHub/GitLab vocabulary (ADR-005). Restart: `next_fire_at`
recomputed from spec + clock at boot — the pillar-4 heart. Self-host: cron clock is local; webhooks
arrive over the tailnet.

### Restart / rehydration story

At module init: for each enabled `cron`/`heartbeat` schedule, recompute `next_fire_at` from its spec
relative to `clock.now()`; if the recomputed (or stored) next-fire is already in the past, apply the
missed-fire policy on the first `scanDue()`. Event schedules carry no clock state. No event-log replay
(schedules are config + fire-history, not conversation). The restart test asserts a second module
instance rebuilds a coherent `next_fire_at` with no in-memory truth.

## Sub-phase C design (loop primitive) — design + red tests only (2026-07-07)

A **loop** is the standing task that makes rung 2 *Autopilot*: `{goal, trigger, budget, stop,
escalation}` as a durable record. It fires **loop-runs** — each a task (rung 1), in a fresh worktree,
with project defaults resolved (A) — through the scheduler (B), inside run-count budgets and a
consecutive-failure breaker, landing output via worktree + PR. **All counting is derived from durable
`loop_runs` rows** (restart-safe, no in-memory counters). Locked constraints: budgets = run-count
(`maxRunsPerDay` + `maxConsecutiveFailures`); breaker pauses after 3 consecutive failures (per-loop
overridable) + emits needs-attention (rung-1 vocabulary); output ALWAYS worktree + PR, never a direct
branch write.

### Scout (what already exists — reuse)

- **PR creation seam exists.** `ForgesService.openPullRequestForSession(id)` takes a session that has
  a `branch` + `worktreePath` and opens a PR through the `ForgeProvider` (GitHub/GitLab, ADR-005);
  `git.service` has `commit`, `push`, `createWorktree`. So the loop's PR leg is small — it reuses
  these, it is NOT new plumbing.
- **Task outcome is durable + already carries the loop signal.** `TasksService.execute` finishes a
  task `DONE`/`FAILED` with `outcome_json = {sessionStatus, verify:{ok,…}, needsAttention?}` after
  awaiting `awaitVerifySettled` (so it reflects the rung-1 terminal verify, not the first red). A
  loop-run's outcome derives from the task's terminal status + `verify.ok` / `needsAttention`.
- **Scheduler target seam (B).** A schedule's `{kind:'loop', loopId}` target resolves to a loop-run
  fire — the loop closes B's seam.

### Loop record — the 5 fields mapped to schema (ADR-006, guarded CREATE)

```sql
CREATE TABLE IF NOT EXISTS loops (
  id                       TEXT PRIMARY KEY,
  goal                     TEXT NOT NULL,     -- (1) the prompt each run enqueues
  schedule_id              TEXT NOT NULL,     -- (2) trigger — the loop OWNS this schedules row
  max_runs_per_day         INTEGER NOT NULL,  -- (3) budget count
  max_consecutive_failures INTEGER NOT NULL,  -- (3) budget / breaker threshold (default 3)
  stop_json                TEXT,              -- (4) stop condition: NULL | {"kind":"maxTotalRuns","n":N}
  escalation               TEXT NOT NULL,     -- (5) escalation policy: 'needs-attention' (v1)
  project_path             TEXT,              -- soft ref → project entity (engine/verify/auto-steer)
  status                   TEXT NOT NULL DEFAULT 'active', -- active | paused | broken | completed
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loop_runs (
  id         TEXT PRIMARY KEY,
  loop_id    TEXT NOT NULL,
  task_id    TEXT,                            -- the task this run enqueued
  outcome    TEXT NOT NULL,                   -- 'ok' | 'failed' | 'budget-exhausted' | 'resume'
  day_bucket TEXT NOT NULL,                   -- local YYYY-MM-DD (day-count key, tz-naive)
  created_at INTEGER NOT NULL
);
```

- **Loop OWNS its schedule** (not vice-versa): the schedule is the loop's trigger — meaningless
  without the loop — so the loop is the aggregate root, holds `schedule_id`, and deleting the loop
  deletes its schedules row (no orphan trigger). Justification: a one-to-one where the trigger's
  lifecycle is strictly the loop's; the reverse (schedule owns loop) would let a schedule outlive its
  only reason to exist.
- **YAGNI:** exactly the 5 fields + project_path + status + timestamps. No per-loop token budgets
  (rung 4), no context files (rung 3), no extra knobs.

### Stop condition v1 — LOCKED (founder, 2026-07-07): null | maxTotalRuns | **verifyGreenN pulled into v1** (founder override of the defer recommendation) — FLAGGED founder decision

**Recommendation: `null` (standing, run until paused) | `{kind:'maxTotalRuns', n}`.** Maintenance /
overnight-batch loops are standing (null); improvement loops ("do N runs then stop") get
`maxTotalRuns` — a durable count over `loop_runs`, restart-safe. **Deferred:**
`verify-green-N-consecutive` (needs cross-run verify history + a definition of "consecutive green"
that the breaker's failure-streak machinery half-provides — cleaner to add once the run-accounting is
proven). Flagged: the founder may want the improvement family's green-streak stop in v1.

### A loop run IS a task (accounting derived from durable rows)

A fire (scheduler → loop) enqueues a **task** with: `prompt = loop.goal`, `useWorktree = true`
(**locked** — a loop NEVER runs in-place, enforced regardless of the project's `worktreePolicy`),
`projectPath = loop.project_path` (so engine via project entity → `AgentRegistry`, verify + auto-steer
per project — no engine branch). A `loop_runs` row is written at fire time (task_id, day_bucket).

**Run outcome accounting** (restart-safe, from durable rows): when the task settles
(`awaitVerifySettled`), the loop-run's outcome is derived from the task's `outcome_json`:
- task `DONE` + `verify.ok === true` (or no verify) → **`ok`**, resets the failure streak;
  red-then-autofixed by the rung-1 loop lands here (verify went green).
- task `FAILED`, or outcome carries `needsAttention` (rung-1 gave up) → **`failed`**, streak++.

The **failure streak** and **today's run count** are both *folded from `loop_runs`* — the streak is the
count of trailing `failed` runs since the last `ok`/`resume`; today's count is the number of runs whose
`day_bucket` equals the local `YYYY-MM-DD` of `clock.now()`. No in-memory counters → a restart rebuilds
both by re-folding (the restart test).

### Budgets & breaker

- **`maxRunsPerDay`**: before a fire, if today's `loop_runs` count (by `day_bucket`) `>= maxRunsPerDay`,
  skip with a `budget-exhausted` run row and do not enqueue. The day boundary is **local midnight,
  timezone-naive** (documented, like B; DST a known v1 limitation). Crossing midnight (injected clock)
  resets the day bucket → fires resume.
- **Breaker**: the failure streak (folded from `loop_runs`) reaching `maxConsecutiveFailures` (default
  3, per-loop overridable) **trips**: set `status='broken'`, **disable the loop's schedule** (via the
  scheduler seam, so no further fires), and **emit a needs-attention signal** reusing the rung-1
  vocabulary (`verify_needs_attention`-shaped payload with `{reason:'loop_breaker', loopId, streak}`)
  so the rung-3 attention queue keys on one vocabulary.
- **Manual resume**: `status='active'`, re-enable the schedule, and write a `resume` run row so the
  streak fold resets to 0 (the resume row is the fold boundary). A success mid-streak also resets it
  naturally (an `ok` is a fold boundary).

### The PR leg (locked "worktree + PR")

Reuses the existing seam. On a green run, the loop: commits the agent's worktree changes
(`git.service.commit`) → pushes (`git.service.push`) → opens a PR (`ForgesService.openPullRequestForSession`)
**when the project has a forge remote configured**; otherwise it leaves the committed worktree branch
and surfaces it (the branch is the deliverable, PR-able later). **This is a design contract for this
sub-phase** (unit tests can't drive a live forge/git remote); the seam is real and small, so v1 ships
PR-when-possible + branch-commit fallback — no scope flag needed, but the one honest dependency is that
the agent actually left committable changes in the worktree (a no-op run commits nothing → no PR).

### API surface (phone-ready)

- `POST /loops` `{ goal, schedule:{kind,spec}, maxRunsPerDay?, maxConsecutiveFailures?, stop?,
  projectPath? }` — creates the loop + its schedule (one call).
- `GET /loops` / `GET /loops/:id` — list / one (status, budgets, last run, streak).
- `POST /loops/:id/pause` · `POST /loops/:id/resume` — pause disables the schedule; resume re-enables +
  zeroes the streak (only a `broken` or `paused` loop resumes).
- `DELETE /loops/:id` — removes the loop + its schedule (run history: **kept** as durable history by
  default — FLAGGED: cascade-delete is the alternative).
- `GET /loops/:id/runs` — the durable `loop_runs` history (the fleet-view / digest data).

All shapes are UI-ready (status enum, counts, last-run) so the rung-3 phone surfaces render directly.

### Direction-test walk (C)

Phone: create/pause/resume/needs-attention/run-history all REST + UI-ready. Engine: a loop run's
engine comes from the project entity via `AgentRegistry` — no engine branch (ADR-004). Forge: PR leg
goes through `ForgeProvider` (GitHub + GitLab). Restart: streak + day-count re-folded from `loop_runs`
at boot — the pillar-4 heart. Self-host: worktrees local, PRs via CLI forge creds.

### Restart / replay story

No event-log replay (loops are config + run-history rows). At boot the scheduler already rehydrates
`next_fire_at` (B); the loop layer adds nothing stateful in memory — streak and today's count are pure
folds over `loop_runs`, so a fresh module computes identical budget/breaker state. The restart test
asserts a second module derives the same streak (e.g. mid-breaker) and day-count.

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
