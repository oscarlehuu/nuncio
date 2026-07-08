# Phase 3 — Attention (Rung 3)

**Status:** Design + red suite for **sub-phase A** (2026-07-07). This doc is the rung-3 master plan
(sub-phase breakdown + founder-decision table + direction-test walk) plus the full sub-phase A design
(attention-queue backbone) and its red suite. Sub-phases B–D are designed at the master level and
distilled into their own detail when they start — same cadence as rung 2.

## Goal

**Done-when (dogfood):** the founder drives a full working day from the phone only. Rung 3 turns the
scattered "needs you" signals rungs 1–2 already produce into **ONE ranked attention queue**, adds a
**heartbeat** rhythm (infra self-check / fleet reconciliation / human digest), **diff review with
comment-to-steer**, and a **fleet home** of project-health rows. Every surface must pass the phone
test — that is the point of the rung, not a nice-to-have.

The scarce resource is founder attention. Sub-phase A raises decisions-per-minute-of-attention by
collapsing N scattered alerts into one ordered list with one-tap ack/resolve.

## What already exists (scout — extend, don't duplicate)

Rungs 1–2 already emit every raw signal the queue needs. Sub-phase A is a **collector + ranker + a
durable table**, NOT new signal sources.

| Signal the queue needs | Where it already lives (source of truth) |
|------------------------|------------------------------------------|
| **Permission / interaction request** | `user_input_requested` / `user_input_resolved` session events (`events.types.ts:14`); derived pending-input (`derive-pending-input.ts`). Open request = attention. |
| **Verify-dead after N rounds** | `verify_needs_attention` session event (`events.types.ts:24`), emitted by the rung-1 auto-steer loop when it gives up. |
| **Tripped breaker** | Loop `status === 'broken'` (`loops.types.ts:1`), set by `LoopsService.trip` (`loops.service.ts:533`); the doc there already says "the durable 'broken' status IS the attention signal a fleet view reads." |
| **PR awaiting review** | `ForgeProvider.listPullRequests` / `listRepositories` (rung 2 v1.1) — provider-neutral (GitHub + GitLab). |
| **Anomaly** (long-running session, empty diff; loop burning budget, no progress) | Derived from existing session events + loop_runs rows + git worktree diff — heuristics, sub-phase C. |
| **Expiring CLI credential** | `cli-auth` (`githubCliToken`/`gitlabCliToken`) + provider `resolveAuth` — heartbeat infra layer, sub-phase B. |

**Two load-bearing seams already exist — the whole rung leans on them, no new plumbing:**

- **`registerSessionEventHook(hook)`** (`session-event-hooks.ts:12`) — an observer fired **exactly
  once per persisted event**, and it "must never throw into the append path" (already swallow-safe).
  This is where the permission/verify-dead collectors subscribe. No new event type needed (ADR-007).
- **`SchedulerService` with a `heartbeat` kind** (`scheduler.types.ts:3`) and a
  handler-registration pattern (`setLoopFireHandler`, `scheduler.service.ts:144`). The heartbeat
  (sub-phase B) rides this exactly: register a handler, own a `{kind:'heartbeat'}` schedule.

**Design consequence:** sub-phase A adds an `attention_items` CONFIG-durable table (ADR-006, guarded
CREATE) + collectors that subscribe to the seams above + a ranker + a REST surface. It introduces
**zero new session event types** and **zero new engine/forge branches**.

## Sub-phase breakdown (dependency order)

Proposed cut, justified from code reality. Each sub-phase is independently shippable and dogfoodable;
later ones depend on A's durable queue existing.

| Sub | Name | Depends on | Why this order |
|-----|------|-----------|----------------|
| **A** | **Attention queue backbone** | rungs 1–2 signals | The queue is the spine — heartbeat digests read from it, fleet home badges it, diff-review resolves items. Nothing downstream is meaningful until items exist, dedup, rank, and resolve. Ship first. |
| **B** | **Heartbeat (3 layers)** | A (digest reads the queue) | Rides the existing scheduler. Infra self-check *produces* attention items (expiring creds, zombie sessions) → depends on A's table. Digest is **data-first** (a `buildDigest()` over queue + loop_runs + costs), delivery via the existing `PushModule` + an in-app view. |
| **C** | **Fleet home + anomaly heuristics** | A (badges + anomaly items) | Project-health rows = f(CI, PRs, running sessions, verify streak, last activity). Anomaly heuristics are new *collectors* feeding A's table (long-running-empty-diff, budget-burn-no-progress). Needs the project entity (rung 2 A) for health + importance. |
| **D** | **Diff review + comment-to-steer** | A (resolve a PR/verify item from the diff), rung-1 steer | Per-session/task worktree diff; select a hunk → steer with `file:line` context (reuses the rung-1 steer path). The phone version is the killer feature. Resolving a review item closes the loop back to A. |

**Amendment to the coordinator's proposed cut:** kept A→B→C→D as proposed. One refinement — **B's
infra self-check and C's anomaly heuristics are both "collectors that write into A's table,"** so A
must ship the collector-registration seam generically (not hard-code the rung-1/2 collectors), and
B/C add collectors without touching A's core. This keeps ADR-007 additivity honest and lets B and C
proceed concurrently once A lands.

## Founder-decision table — proposed (recommendations; needs founder lock before A implementation)

**LOCKED (founder, 2026-07-07): all 8 as recommended** — static severity buckets · ack≠resolve + auto-resolve · persist+reconcile · digest push+in-app · cadences 15m/1h/2×day · manual project weight · worktree-diff-only v1 · exactly 2 anomaly heuristics.

| # | Decision | Recommendation | Rationale |
|---|----------|----------------|-----------|
| 1 | **Ranking formula v1** | **Static severity buckets** (permission > verify-dead > tripped-breaker > PR-review > anomaly), then project-importance weight, then age. NOT a learned/weighted score. | KISS + explainable + deterministic (testable). A learned score is rung-4 intelligence territory; v1 must be a total order the founder can predict from the phone. |
| 2 | **Queue item lifecycle** | **Auto-resolve when the underlying condition clears** (loop resumed → item resolves), PLUS a separate **ack** ("seen", mutes the badge, item stays open) and a manual **resolve** (founder override). Ack ≠ resolve. | Auto-resolve keeps the queue honest without founder toil (a loop that self-heals shouldn't nag). Ack lets the founder triage a still-live item ("I saw it, dealing with it") without falsely clearing it. Manual resolve is the escape hatch. |
| 3 | **Restart strategy** | **Persist + reconcile** (durable rows; on boot re-check each open item against live state and auto-resolve the stale). NOT pure re-derive. | PR-review, expiring-cred, and ack/resolve state have **no other durable home** — pure re-derive from events would lose founder ack state and PR context. Loops derive from `loop_runs`; attention can't, because ack is founder input. Reconcile gives restart-safety without losing that input. |
| 4 | **Digest delivery channel (B)** | **Both** — data-first `buildDigest()`, delivered via existing `PushModule` (morning/evening push) AND an in-app digest view. Push is a pointer; the view is the content. | Phone test demands push (the founder isn't watching a dashboard at 8am). In-app view avoids cramming a day's summary into a notification. Reuses `PushModule` — no new delivery infra. |
| 5 | **Heartbeat cadences (B)** | Infra self-check **every 15 min**; fleet reconciliation **hourly**; digest **2×/day** (~08:00 local morning, ~20:00 evening), all founder-tunable via settings keys. | 15 min catches an expiring cred / zombie before it kills a night's queue without hammering forge APIs; hourly reconciliation matches loop cadence; digest rhythm is the morning/evening ritual from the cockpit map. |
| 6 | **Project importance source (ranking + fleet home)** | **Manual per-project weight field** (integer, default 1) on the project entity (rung 2 A), v1. Activity-derived is a rung-4 refinement. | Explicit + deterministic + testable now; the founder knows which projects matter more than a heuristic does. Additive column on `projects` (guarded ALTER). |
| 7 | **Diff-review scope v1 (D)** | **Worktree diffs only** (the session/task worktree vs its base), not arbitrary forge PR diffs. | The worktree is where nuncio's own work lives and where comment-to-steer has a live session to steer. Forge-PR-diff review is a read-only superset that can wait; steering a merged PR has no session to steer. |
| 8 | **Anomaly heuristics v1 (C)** | Exactly two, matching the plan: **(a)** session RUNNING > T minutes with an empty worktree diff; **(b)** loop with ≥N runs today all `failed`/`budget-exhausted` and no green verify. Both tunable, both feed A as `anomaly` items. | Resist a general anomaly framework (non-goal: no workflow engine). Two concrete, high-signal heuristics the founder actually hit. |

## Direction-test walk (product-vision.md — the phone test is the heart of this rung)

Rung 3 exists to be driven from the iPhone. Every sub-phase is walked against all five tests; the
phone test is load-bearing, not advisory.

- **Phone test.** A: the queue is a single list endpoint + counts for a badge — renders as a phone
  inbox with one-tap ack/resolve; badge rides the existing relay (no polling). B: digest is a push +
  a scrollable view. C: fleet home is health rows (thumb-scrollable). D: diff review + hunk-steer is
  explicitly "the phone version is the killer feature." **If any surface needs a desktop, it fails
  this rung.**
- **Engine test.** Collectors read session events + loop status + task rows — provider-neutral. No
  `if (provider === 'pi')` anywhere in a collector or the ranker. Verify-dead/permission signals are
  the same event types across engines.
- **Forge test.** PR-review items come from `ForgeProvider.listPullRequests` — GitHub AND GitLab, no
  forge branch. Expiring-cred check (B) uses `resolveAuth` per provider, provider-neutral.
- **Restart test.** `attention_items` is durable (ADR-006, guarded CREATE); on boot, open items are
  reconciled against live state (decision #3). Ack/resolve survive restart. A dedup UNIQUE index over
  open rows is DB-enforced, so a restart mid-signal can't double-insert.
- **Self-host test.** Zero cloud services — SQLite table, local collectors, push via the existing
  self-hosted `PushModule` (Web Push / VAPID already in-repo). Heartbeat is a local scheduler tick.

---

# Sub-phase A design — attention queue backbone

Signal collectors → durable ranked `attention_items` table → REST (list / ack / resolve + counts) →
badge seam on the relay. Design + red suite only in this task.

## How signals flow in (collectors — additive, ADR-007)

A **collector** is a small unit that watches an existing signal source and calls
`AttentionService.raise({ kind, subjectId, projectPath?, payload })` when a condition holds, and
relies on the resolver to clear it when the condition lifts. **No new event types** — collectors read
what rungs 1–2 already emit:

- **PermissionCollector** — subscribes via `registerSessionEventHook`; on `user_input_requested`
  raises a `permission` item keyed to the session; a `user_input_resolved` for the same request lets
  the resolver clear it.
- **VerifyDeadCollector** — same hook; on `verify_needs_attention` raises a `verify-dead` item.
- **BrokenLoopCollector** — hooks the loop settlement path (the breaker already flips
  `status='broken'` in `LoopsService.trip`); raises a `tripped-breaker` item. Resolver clears it when
  the loop leaves `broken` (resume/delete).
- **PrReviewCollector** — runs on the heartbeat fleet-reconciliation cadence (sub-phase B); lists
  open PRs awaiting the founder via `ForgeProvider` and raises `pr-review` items.
- (sub-phase C) **AnomalyCollector** — heuristics over sessions + loop_runs.

Collectors register through a generic `AttentionService.registerCollector` / `raise` seam so B and C
add collectors without editing A's core (keeps additivity honest).

## The `attention_items` table (ADR-006 — guarded CREATE, no migration framework)

```
CREATE TABLE IF NOT EXISTS attention_items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- permission | verify-dead | tripped-breaker | pr-review | anomaly | <future>
  subject_id      TEXT NOT NULL,          -- sessionId | loopId | prKey | … (the thing needing attention)
  project_path    TEXT,                   -- for project-importance ranking + fleet grouping (nullable)
  severity        INTEGER NOT NULL,       -- static bucket rank (higher = more urgent); derived from kind at raise
  title           TEXT NOT NULL,          -- phone-ready one-liner
  payload_json    TEXT,                   -- kind-specific detail (requestId, verify tail ptr, PR url, …)
  status          TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  acknowledged_at INTEGER,                -- ack = "seen"; NULL until acked; does NOT resolve
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  resolved_at     INTEGER                 -- set when status→resolved (auto or manual)
);
-- DB-enforced dedup: at most ONE open item per (kind, subject_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_open_dedup
  ON attention_items(kind, subject_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_attention_status ON attention_items(status, severity);
```

**Dedup (one item per condition):** the partial UNIQUE index over `status='open'` makes stacking
impossible at the DB layer — a re-signal of an already-open condition is an idempotent update
(`updated_at` bumps), not a second row. Because the index is over open rows only, a **resolved** item
does not block a later re-trip: when the condition re-occurs, a fresh open row is inserted (decision:
re-occurrence after resolve = a NEW item, so the founder is not silently re-nagged nor silently
ignored). `raise` is `INSERT … ON CONFLICT(kind,subject_id) WHERE status='open' DO UPDATE`.

**Restart-safe (decision #3 — persist + reconcile):** rows are durable. On boot,
`reconcileOpenItems()` walks every open item and asks its kind's resolver "is the condition still
live?" (loop still `broken`? request still unresolved?) — auto-resolving the stale ones. This
recovers from state that changed while the daemon was down (a loop resumed on another process) without
losing founder ack/resolve input.

## Ranking (decision #1 — static severity buckets)

Total, deterministic order for a stable phone list:

```
severity bucket DESC  →  project importance weight DESC  →  created_at ASC  →  id ASC (stable tiebreak)
```

- Severity buckets (v1 static, highest first): `permission (5) > verify-dead (4) > tripped-breaker (3)
  > pr-review (2) > anomaly (1)`. An **unknown/legacy kind ranks last (0)** and never throws —
  forward-compat.
- Project importance = the manual `weight` field on the project entity (decision #6), default 1.
- `created_at ASC` surfaces the oldest unmet need first within a bucket; `id` is the final stable
  tiebreak so the order never flickers between requests (ranking-order-stability test).

Ranking is a **pure function** over `(items, projectWeights, now?)` → ordered items, unit-testable
with injected weights and clock.

## Ack / resolve semantics (decision #2)

- **ack(id)** — sets `acknowledged_at`; item **stays open** (still actionable, still ranked). Ack
  only removes the item from the "needs you" **badge count** (mutes the nag). Ack of an unknown id →
  404.
- **resolve(id)** — manual founder override; `status='resolved'`, `resolved_at` set, even if the
  underlying condition is still live (the founder decided it's handled). A later re-signal creates a
  fresh open item (index is over open rows only).
- **auto-resolve** — the resolver clears an open item when its condition lifts (loop resumed,
  request answered). Same terminal state as manual resolve.
- **already-resolved** ack/resolve → **idempotent no-op returning the current row** (not a 4xx):
  resolving twice is harmless and the phone may double-tap on a laggy link; idempotent is friendlier
  than an error. (Justified over 409; flagged reversible.)

## REST surface (phone-ready)

```
GET    /attention                 → { items: RankedItem[], counts: { total, unacked, bySeverity } }
POST   /attention/:id/ack         → the acked item (acknowledged_at set, still open)
POST   /attention/:id/resolve     → the resolved item (status resolved)
```

`counts.unacked` is the badge source (open ∧ not acknowledged). `items` are ranked (above). Exact
controller wiring is A-implementation; the red suite targets the **service + repository + ranker**
(the logic), with a thin controller contract test.

## WS / badge streaming seam (design; NO new WS contract — ADR-007 additive)

The badge must update live on the phone without polling. **Seam, not a new transport:** when
`AttentionService` mutates the queue (raise / ack / resolve / auto-resolve), it calls a single
injected `onChange()` sink. In production that sink pushes a compact `attention_counts` frame onto the
**existing session relay** (the same WS clients already hold open) — an *additive* frame type, not a
new socket or a versioned contract change. In tests the sink is a spy, so "a raise emits a
badge-change" is unit-assertable without a live socket. The relay wiring itself is A-implementation;
the **seam** (service → onChange sink) is designed and red-tested now.

## Restart / replay story (ADR-006)

1. Guarded `CREATE TABLE`/indexes on boot — fresh DB and a pre-existing DB lacking the table both
   converge (db.spec covers migration-from-nothing).
2. Open items are durable rows; resolved items stay resolved.
3. `reconcileOpenItems()` runs on boot: each open item's kind-resolver re-checks live state and
   auto-resolves the stale (a loop that resumed while the daemon was down loses its `tripped-breaker`
   item). This is the attention analogue of the rung-2 `reconcilePendingRuns`.
4. Ack/resolve state survives (it lives in the row), so the founder's morning triage isn't undone by
   an overnight restart.

## Red suite for sub-phase A

Edge-case-first, deterministic (injected `Clock`). Skeletons throw **neutral `TODO:`** so
validation-reject tests never false-green. Full enumerated ledger:
`.claude/maestro/rung3-attention/edge-cases.md` (27 rows). Test files (red until A implemented):

- `attention.ranking.spec.ts` — pure ranker: severity-bucket order, project-weight tiebreak,
  created-at + id stability, unknown-kind-ranks-last, multi-project ordering.
- `attention.service.spec.ts` — raise/dedup (no stack), re-signal idempotent, distinct-condition
  separate items, auto-resolve on condition-clear, re-occur-after-resolve = fresh item, ack keeps
  open + mutes badge, manual resolve overrides live condition, ack/resolve unknown → 404,
  already-resolved idempotent, counts (total/unacked/bySeverity), onChange badge seam (spy),
  malformed-signal rejected, injected-clock timestamps.
- `attention.repository.spec.ts` — durable CRUD, open-dedup UNIQUE index enforced at DB, persist +
  reconcile across a restart (rebuild module on same DB), resolved rows don't block re-trip.
- `attention.reconcile.spec.ts` — boot reconciliation: open item whose condition cleared while down
  → auto-resolved; still-live condition → stays open.
- `db/database.service.spec.ts` (extend) — guarded CREATE of `attention_items` + indexes from a
  pre-existing table-less DB (migration-from-nothing), and the manual project `weight` column
  guarded-ALTER.

## ADR compliance walk (A)

- **ADR-006** — durable table, guarded CREATE, positional params, no migration framework; state
  rebuilds on boot.
- **ADR-007** — additive only: NO new `SessionEventType`; collectors read existing events/states; the
  badge frame is additive on the existing relay, not a new/breaking contract. A red test asserts the
  `SessionEventType` union is unchanged by this rung.
- **ADR-004** — collectors + ranker touch engines only through existing provider-neutral signals; no
  engine branch.
- **ADR-005** — PR-review + expiring-cred read forge state through `ForgeProvider`; GitHub + GitLab
  identical.

## Founder decisions (status)

All 8 rows in the decision table above are **proposed recommendations, not yet locked** — this task
is design + red only. They need a founder lock before sub-phase A implementation, exactly as rung 2's
table was locked before its build. Flagged reversible: decision #2 (ack≠resolve), #3 (persist+
reconcile over pure-derive), and the already-resolved-idempotent choice are the ones most worth an
explicit founder confirm.

---

# Sub-phase B design — heartbeat (3 layers)

**Status:** Design + red suite (2026-07-07). Sub-phase A is closed (server + Inbox UI + live smoke).
Founder-locked constraints: **3 layers**; cadences **infra 15min / fleet-reconcile hourly / digest
2×/day (~08:00, ~20:00)**, all founder-tunable; **digest data-first**, delivered via **PushModule +
in-app view**. The heartbeat rides the **rung-2 scheduler** (a `heartbeat` kind + handler-registration
seam already exist). It is a rhythm layer: it PRODUCES attention items (through the sub-phase A seam)
and SUMMARIES, it does not add a new signal store beyond a tiny digest marker.

## What already exists (scout — lean on it, don't rebuild)

| Need | Where it lives | How B uses it |
|------|----------------|---------------|
| Cadence firing | `SchedulerService` — `heartbeat` kind, `scanDue()`, boot rehydrate, `missed`/fire-once, per-schedule overlap guard (`inFlight`) | The 3 layers are 3 system schedules; a new `{kind:'system'}` target + `setSystemFireHandler` seam mirrors `setLoopFireHandler` (`scheduler.service.ts:144`). |
| Forge auth probe (bounded) | `ForgesService.listStatus()` — `resolveAuth()` (cheap, cached) + `getCurrentUser()` behind `withTimeout(2500)` (`forges.service.ts:132-149`) | Credential VALIDITY probe: connected-but-`getCurrentUser` throws/401 = invalid/expiring. Absent token = "not configured", NOT a failure. |
| Agent provider probe | `AgentRegistry.available()` (`agents.registry.ts:43`) | Same pattern for provider auth where a provider exposes a validity probe. |
| Attention raise/resolve + suppression | sub-phase A `AttentionService` (`raise`, `onConditionCleared`, suppress-reraise) | Every failed check raises an item; a passing check calls `onConditionCleared` (auto-resolve, founder-override-safe). |
| Boot reconcile passes | `AttentionService.reconcileOpenItems`, `LoopsService.reconcilePendingRuns` (idempotent by design) — vs `SchedulerService.rehydrate` (recomputes nextFire) | Layer 2 runs the two IDEMPOTENT reconciles on a cadence; it does NOT run `rehydrate` (that mutates schedule timing and is boot-only). |
| Loop/run + budget data | `loop_runs` rows (`createdAt`, `outcome`), `computeLoopStats` | `buildDigest()` reads these for since-last deltas + today's usage. |
| Push delivery | `PushService` (Expo transport, test seam) — currently session-event-driven only (`push.service.ts:77`) | Add an additive `broadcast(content)` for the digest (no new transport). |
| Latest-event age | events table `created_at` per row | Add a cheap `latestEventAt(sessionId)` (`SELECT MAX(created_at)`) for zombie detection. |

## Design questions — resolved (proposed; flag only genuine can't-picks)

### Q1 — Layer 1 infra self-check: exact v1 checks
1. **Credential validity (expiring/invalid)** — for each *connected* forge (`resolveAuth() !== null`),
   probe `getCurrentUser()` behind a per-check timeout. Throw/401 → raise a
   `credential-expiring` item keyed `forge:<id>`. **Absent token → NO item** (unconfigured ≠ broken —
   distinguishing these is the whole point; a dead `glab` token at 3am must page, an intentionally
   unused GitLab must not). Recommendation: reuse `ForgesService.listStatus()`'s exact probe shape so
   there is ONE auth-probe path; the check is cheap (one `/user` call per connected forge, ≤2.5s,
   every 15min — no rate-limit risk).
2. **Zombie sessions** — a session `RUNNING` whose `latestEventAt` age `> T` (default 30min, tunable)
   while the daemon is alive. Raise `zombie-session` keyed `session:<id>`. This is DISTINCT from the
   boot pass `reconcileInterruptedSessions` (which fires RUNNING→IDLE on ANY running session at boot,
   assuming the daemon died) — the heartbeat catches a session that hangs *while we're up*. v1 raises
   an attention item (surfaces it); it does not auto-kill (founder decides).
3. **Disk-space floor** for `NUNCIO_DATA_DIR` + clone dir — **PROPOSED then CUT for v1 (YAGNI)**. A
   self-hosted single-founder box rarely hits a disk floor silently, and a cheap portable free-bytes
   check across platforms is fiddly. FLAG: add in v1.1 if the founder wants it; the collector seam is
   generic so it drops in without touching layer plumbing.
   New kinds → added to `SEVERITY_BY_KIND`: `credential-expiring` (high — a dead cred kills the night)
   and `zombie-session` (mid). The Inbox already tolerates unknown kinds; ranking them is the change.

### Q2 — Layer 2 fleet reconciliation: what it re-checks
Run the **two idempotent boot-reconcile passes on a cadence**: `AttentionService.reconcileOpenItems()`
(auto-resolve items whose condition cleared) and `LoopsService.reconcilePendingRuns()` (fold a
crashed/settled task's run). Both are already written to be safe to re-run (they only act on
open/pending rows against live terminal/probe state, never re-fire a live loop run or re-resolve a
still-live item — proven by the rung-1/2 restart suites). **EXCLUDED: `SchedulerService.rehydrate()`**
— it recomputes `next_fire_at` and would perturb cadence timing if run mid-cycle; it is boot-only by
design. The red suite asserts the two included passes are idempotent (double-run = no-op) and that
rehydrate is NOT invoked by the hourly job.

### Q3 — Layer 3 digest: shape, storage, delivery, variants
- **Shape (`buildDigest(data, sinceMs, now, variant)` — pure):**
  `{ variant, windowFrom, windowTo, loops: {runsOk, runsFailed, prsOpened}, attention: {raised,
  resolved, openTop: RankedItem[N]}, sessions: {completed, needsYou}, budget: {runsToday, cap} }`.
  Deltas are "since the last digest marker"; `openTop` + `budget` are current snapshots.
- **Storage — `digest_runs` marker table (ADR-006), NOT a full digests archive:** one row per SENT
  slot: `{ slot_key TEXT PRIMARY KEY, variant, sent_at, window_from, window_to, summary_json }`.
  `slot_key = '<YYYY-MM-DD>:<morning|evening>'`. The **since-last window** derives from the previous
  marker's `window_to` (durable across restart → Q14). Storing the summary_json lets the in-app GET
  return the last built digest without recomputing. Recommendation: marker-table over derive-on-demand
  because delivery idempotency (Q15/16) needs a durable "already sent this slot" record anyway.
- **Delivery — BOTH:** `PushService.broadcast({title, body, data})` (short: e.g. *"3 shipped, 1 needs
  you, 12 runs"* + a `data.slotKey` pointer) AND `GET /heartbeat/digest?slot=latest` for the in-app
  view (returns the durable `summary_json`, UI-ready).
- **Morning vs evening — two templates over the SAME data (v1):** morning = retrospective
  ("what shipped overnight, what's blocked, what it cost"); evening = pre-flight ("what's queued
  tonight" — the open loops due before next morning + attention still open). Same `buildDigest` data;
  the `variant` selects the template + reorders emphasis. FLAG: if the founder wants genuinely
  divergent *data* per variant (not just template), that's a small extension — recommend v1 shared.

### Q4 — Scheduling: three system schedules
Ride the rung-2 `schedules` table with a new target `{ kind: 'system', job: 'infra' | 'reconcile' |
'digest-morning' | 'digest-evening' }` and a `setSystemFireHandler(handler)` seam on
`SchedulerService` (mirrors `setLoopFireHandler`; the `fire()` switch gains a `system` arm). On boot,
`HeartbeatService` **ensures the schedules exist (upsert-by-job, idempotent — a reboot never
duplicates)** with specs from settings. Cadence specs are **founder-tunable via settings keys**
(below) and the system target is **not exposed in the loops UI** (the loops surface only lists
loop-owned schedules), so they are **not deletable/breakable** from there — satisfying the founder
constraint. Settings keys (all with sensible defaults, ADR-005 registry pattern):
`NUNCIO_HEARTBEAT_INFRA_SPEC` (`every:15m`), `NUNCIO_HEARTBEAT_RECONCILE_SPEC` (`every:60m`),
`NUNCIO_HEARTBEAT_DIGEST_MORNING` (`daily@08:00`), `NUNCIO_HEARTBEAT_DIGEST_EVENING` (`daily@20:00`),
`NUNCIO_HEARTBEAT_ZOMBIE_AGE_MIN` (`30`).

### Q5 — Safety (all handlers)
- **Bounded:** every check/probe runs behind a per-check `withTimeout` (reuse the forge pattern) so a
  hung forge probe returns a "check-failed" result rather than wedging `scanDue`. A layer runs its
  checks with `Promise.allSettled` — one timeout never blocks the others.
- **Closed-guarded:** each handler short-circuits on `database.closed` (a fire mid-shutdown is a
  no-op), matching every repo write.
- **Idempotent / double-fire safe:** infra re-raises are deduped by sub-phase A's open-dedup; the
  reconcile passes are idempotent; the digest is slot-keyed (a second fire of the same slot is a
  no-op). The scheduler's own `inFlight` overlap guard already prevents a slow handler from
  re-entering.

## Architecture (design)

- **`HeartbeatService`** (`OnModuleInit`) — registers `setSystemFireHandler`, ensures the 3+1 system
  schedules on boot, and dispatches a fired job to the right layer:
  `infra` → `runInfraChecks()`, `reconcile` → `runFleetReconcile()`, `digest-*` → `runDigest(variant)`.
  Injectable `Clock`; all layers bounded + closed-guarded.
- **`InfraChecks`** — the credential + zombie collectors; each returns a `{ ok, kind, subjectId,
  title }[]` that `HeartbeatService` folds into `AttentionService.raise` / `onConditionCleared`.
- **`buildDigest()`** — pure (`apps/server/src/attention/heartbeat/digest.ts`), plus a
  `DigestRepository` (marker table) for since-last window + slot idempotency + in-app read.
- **`PushService.broadcast()`** — additive.
- **`HeartbeatController`** — `GET /heartbeat/digest?slot=latest` (in-app view).

## Restart / replay story (ADR-006)

1. Guarded `CREATE` of `digest_runs`; guarded ALTER-free (new table only). System schedules
   ensured-on-boot (upsert-by-job) so a reboot converges to exactly 3+1 rows.
2. The since-last digest window derives from the last durable marker → correct deltas across a
   restart between digests.
3. `missed` fire-once (scheduler) + `digest_runs` slot marker together guarantee a digest is not
   double-sent when a missed slot is caught up on boot.

## Direction-test walk (B)

- **Phone test** — the digest push lands on the iPhone; the in-app digest view + the Inbox items
  (credential-expiring, zombie) are all phone-rendered. THE point of the layer.
- **Engine/Forge test** — cred probes reach every provider/forge through the registries; no engine or
  forge branch. GitLab cred expiry pages exactly like GitHub.
- **Restart test** — schedules + digest marker durable; since-last window survives; no double-send.
- **Self-host test** — all local: SQLite marker, local scheduler tick, Expo push via the existing
  self-hosted PushModule. Zero new cloud dependency.

## Red suite for sub-phase B

Edge-case-first, deterministic (injected `Clock`), neutral `TODO:` skeletons (no false greens). Full
ledger: `.claude/maestro/rung3-attention/edge-cases-B.md` (32 rows). Test files:
- `heartbeat/infra-checks.spec.ts` — credential invalid→item, valid-again→auto-resolve (suppress
  respected), absent→no item, zombie boundary (exactly-at-T not flagged, one-past is), healthy→none,
  probe-timeout isolation, new kinds in the severity map.
- `heartbeat/heartbeat.service.spec.ts` — layer dispatch, per-check timeout isolation, closed-guard,
  double-fire idempotency, ensure-schedules-once.
- `heartbeat/fleet-reconcile.spec.ts` — runs the two idempotent passes, double-run no-op, does NOT
  call rehydrate.
- `heartbeat/digest.spec.ts` — pure `buildDigest` deltas, empty digest, morning/evening templates,
  since-last window from marker, restart-durable window.
- `heartbeat/digest-repository.spec.ts` — slot marker durable, not-double-sent on catch-up, slot
  idempotency, latest read.
- `heartbeat/push-broadcast.spec.ts` — payload shape via transport spy.
- `scheduler` (extend) — `{kind:'system'}` target + `setSystemFireHandler` fires; overlap guard holds.
- `db/database.service.spec` (extend) — guarded CREATE of `digest_runs`.

## Founder decisions (status — proposed, not yet locked)

| # | Decision | Recommendation |
|---|----------|----------------|
| B1 | Disk-space check v1 | **CUT** (YAGNI); seam ready for v1.1 |
| B2 | Zombie action v1 | **Surface an attention item only** (no auto-kill) |
| B3 | Digest variants | **Two templates, shared data** (v1) |
| B4 | Digest storage | **`digest_runs` marker table** (durable slot + since-last + in-app read) |
| B5 | Credential probe | **Reuse `listStatus` getCurrentUser probe**; absent ≠ failure |
| B6 | Cadence tuning | **Settings keys** w/ locked defaults (15m / 60m / 08:00 / 20:00 / 30min zombie) |

**LOCKED (founder, 2026-07-07): B1 disk check CUT from v1; B3 two templates over shared data — both as recommended.** Original flags: **B1 (disk check in/out)** and **B3 (shared vs divergent digest
data)** — everything else follows the locked constraints. The rest are recommendations consistent with
the founder's B constraints and rungs 1-2 patterns.

---

# Sub-phase C design — fleet home + anomaly heuristics

**Status:** Design + red suite (2026-07-07). Sub-phase B (heartbeat) is closed. Fleet home is the
founder's cockpit LANDING surface — the **phone test rules everything** (project-health rows,
thumb-scrollable, one-tap into a project). Locked constraints: anomaly = **EXACTLY two heuristics**
((a) RUNNING session > T min with an EMPTY diff; (b) loop ≥N runs today all failed/budget with no
green), both tunable, both raising through the sub-phase A seam as NEW kinds in the **bottom severity
bucket**; project importance = the **manual `weight` field** (already exists, rung 3 A/B).

## What already exists (scout — derive, don't duplicate)

Fleet home adds NO new store — it is a **pure fold at GET time** over rows rungs 1-3 already keep.

| Fleet input | Source (already durable) |
|-------------|--------------------------|
| Project list + name + **weight** | `ProjectsRepository.list()` (`weight` default 1) |
| Projects with recent activity | `SessionsRepository.list()` (project_path) + `LoopsService.list()`/loop_runs |
| Open attention per project | `AttentionRepository.list('open')` filtered by `projectPath` (severity via `severityForKind`) |
| Running sessions count | `SessionsRepository.list()` where `status==='RUNNING'` |
| Active loops count | `LoopsService.list()` where `status==='active'` |
| Verify streak | recent `loop_runs.verify` (`verifyGreenStreak` / last green-or-red) |
| Open PRs count | `ForgeRepoService.listPullRequests(path,'open')` (best-effort, forge-neutral) |
| Empty-diff signal (anomaly a) | `GitService` — a lightweight `hasChanges(path)` (`git status --porcelain`, NO numstat) |
| Loop-failing signal (anomaly b) | pure fold over `loop_runs` today (outcome + verify) |

**Two seams from earlier rungs the fleet leans on:** `registerSessionEventHook` is NOT needed here
(fleet is poll/derive, not event-driven); the **anomaly collectors ride the existing
`AttentionCollectors.sweep()`** (broken-loop + PR collectors already live there) so every raiser is
paired with a clear-path — the hard-won sub-phase-B lesson (a poll-collector that only enumerates
current-matching state must also clear items whose subject no longer matches).

## Design questions — resolved (proposed; flag only genuine can't-picks)

### Q1 — Project health aggregation & the formula
**Population rule (C1, proposed):** the fleet is the **union of (a) configured projects
(`projects` table) and (b) projects with a recent session or loop**, deduped by normalized path. A
configured project with no activity still appears (green — nothing needs you); an unconfigured path
that has a running session appears (name = `basename(path)`, weight = 1 default). This is the honest
"everything the founder is running or has configured," not just configured rows.

**Health formula (pure fold — table-testable, explainable, NO scores):**
```
health(project):
  open   = OPEN attention items whose projectPath == project.path
  highBucket = open items with severityForKind(kind) >= HIGH_THRESHOLD   // HIGH_THRESHOLD = 4 (tripped-breaker)
  if highBucket.length > 0                      -> 'red'      // needs you
  else if open.length > 0                       -> 'yellow'   // needs review
  else                                          -> 'green'    // cruising
```
`HIGH_THRESHOLD = 4` (tripped-breaker) means permission(7)/credential-expiring(6)/verify-dead(5)/
tripped-breaker(4) → **red**; zombie-session(3)/pr-review(2)/anomaly-bucket(1) → **yellow**. Rationale:
the top four are "the founder must act or work stops"; the bottom three are "worth a look." Monotone:
red ⊃ yellow ⊃ green, one red item wins. `reasons[]` names WHAT drove the color (e.g. red →
`["2 items need you"]`, yellow → `["1 PR awaiting review","1 anomaly"]`) so the phone row is
self-explaining. The health fold is a pure function `foldHealth(open, running, activeLoops, prs)` →
`{health, reasons, counts}`.

### Q2 — Anomaly collectors (EXACTLY two, both with clear-paths)
**(a) Empty-diff detection — signal source:** the cheapest TRUE signal is a **lightweight
`GitService.hasChanges(path)`** = `git status --porcelain` (bare, WITHOUT the `populateFileStats`
numstat that the full `status()` runs). A tool-activity proxy (counting `tool_end` events) is a
*guess* — an agent can run read-only tools for minutes and still be "empty diff," and can also make
changes via a tool nuncio doesn't classify. `git status --porcelain` is the ground truth and is cheap
(one process, no diff computation). At personal scale (a handful of RUNNING sessions) running it per
running session on the **15-min infra cadence** is fine; if the founder ever runs dozens of
concurrent sessions we revisit, but that is not v1 (flagged). Anomaly (a): a session `RUNNING` for
`> T` minutes (default 30, tunable) whose worktree `hasChanges === false` → raise
`session-empty-diff` keyed `session:<id>`. **Clear-paths:** the diff appears (hasChanges true) OR the
session leaves RUNNING → the collector emits `onConditionCleared`.

**(b) Loop-all-failed-today — pure fold:** a loop whose **today** runs number `>= N` (default 3,
tunable) and are ALL `failed`/`budget-exhausted` with **no** green-verify run today → raise
`loop-failing` keyed `loop:<id>`. Trivial pure fold over `loop_runs` filtered to `dayBucket(now)`.
**Clear-paths:** a green run lands today OR the loop vanishes OR the day rolls over → cleared.

**Cadence:** both ride the **existing 15-min infra sweep** (`AttentionCollectors.sweep()` gains the
two anomaly collectors) — no new schedule. 15 min matches the "long-running > T" grain; a loop that
fails all day is caught within a sweep of its Nth failure. (Justified over a dedicated schedule:
fewer moving parts, and the sweep already has the raise+clear plumbing.)

### Q3 — Where fleet data lives: DERIVE-ON-DEMAND
**Recommend derive-on-demand** — a pure fold at `GET /fleet` time over the existing tables. At
personal scale every input is a small indexed read (projects, sessions, loops, attention, plus a
best-effort forge PR count). No materialized fleet table, no staleness, no migration. FLAG: the only
potentially-slow input is the **forge PR count per project** (a network call per project); v1 makes it
best-effort with a short timeout and treats a failure as "unknown / 0 PRs" (never blocks the row) —
exactly the sub-phase-A/B forge-unreachable discipline. If a founder has many forge-connected projects
and the GET feels slow, cache the PR count on the heartbeat reconcile cadence (a small follow-up, not
v1).

### Q4 — API shape (phone-first)
```
GET /fleet -> { items: FleetRow[] }
FleetRow = {
  path, name, weight,
  health: 'green' | 'yellow' | 'red',
  reasons: string[],                 // why yellow/red (empty for green)
  topItem: RankedAttentionItem | null, // highest-ranked open item for this project
  counts: { openAttention, runningSessions, activeLoops, openPRs },
  lastActivityAt: number | null,     // max(session updatedAt, loop-run createdAt); null if none
}
```
**Ordering (deterministic total order):** `red first (health rank) → weight DESC → lastActivityAt
DESC → path ASC` (stable tiebreak). Red-needs-you floats to the top; within a health tier the
higher-importance project leads; ties break by recency then path so the list never flickers. `topItem`
reuses the sub-phase-A ranker so the row's headline is the same item the Inbox would surface first.

## Architecture (design)

- **`FleetService.list()`** — derive-on-demand: gather the population (projects ∪ active), and for
  each fold `foldHealth` + counts + verify streak + lastActivity + topItem, then order.
- **`foldHealth()` / `orderFleet()`** — pure functions (`apps/server/src/attention/fleet/fleet.ts`),
  table-testable.
- **`AnomalyCollector`** — two heuristics, raise + clear, registered into the `AttentionCollectors`
  sweep (or a sibling the sweep invokes). New kinds `session-empty-diff` + `loop-failing` added to
  `SEVERITY_BY_KIND` at the bottom bucket (severity 1).
- **`GitService.hasChanges(path)`** — additive lightweight porcelain check.
- **`FleetController`** — `GET /fleet` (UI-ready rows).

## Restart / replay story (ADR-006)

Nothing new is persisted — fleet is derived from durable rows that already survive restart, and the
anomaly items live in the sub-phase-A `attention_items` table (durable + reconciled). A restart
mid-run simply re-derives the fleet on the next GET and re-raises/clears anomalies on the next sweep.

## Direction-test walk (C)

- **Phone test** — `GET /fleet` returns ready-to-render rows (health color + reasons + topItem +
  counts); the landing screen is a thumb-scroll of project rows, tap into the Workbench grid. THE
  point of the sub-phase.
- **Engine/Forge test** — health reads provider-neutral signals; PR count via `ForgeProvider`
  (GitHub + GitLab). No engine/forge branch in the fold.
- **Restart test** — derive-on-demand + durable anomaly items; nothing to lose.
- **Self-host test** — all local reads + a best-effort forge call; zero new cloud dependency.

## Red suite for sub-phase C

Edge-case-first, deterministic (injected `Clock`), neutral `TODO:` skeletons. Full ledger:
`.claude/maestro/rung3-attention/edge-cases-C.md` (34 rows). Test files:
- `fleet/fleet-health.spec.ts` — `foldHealth` table: green/yellow/red transitions, high-bucket
  threshold, monotonicity, reasons[], counts, verify streak, lastActivity, zero-signal project.
- `fleet/fleet-order.spec.ts` — ordering (red→weight→activity→path), stable tiebreak.
- `fleet/fleet.service.spec.ts` — population union + dedup, unconfigured-with-session, topItem =
  ranked, unknown-kind tolerance, derive-on-demand over seeded rows.
- `fleet/fleet.controller.spec.ts` — `GET /fleet` shape.
- `attention/anomaly-collector.spec.ts` — (a) RUNNING>T + empty diff raises; boundary T; non-empty →
  none; diff-appears clears; leaves-RUNNING clears. (b) ≥N all-failed no-green raises; N-1 boundary;
  one-green resets; green-after clears; loop-gone/day-roll clears.
- `attention/attention-ranking.spec` (extend) — the two anomaly kinds map to the bottom bucket.
- `git` (extend) — `hasChanges(path)` returns false on a clean worktree, true on a dirty one.

## Founder decisions (status — proposed, not yet locked)

| # | Decision | Recommendation |
|---|----------|----------------|
| C1 | Population rule | **Union: configured ∪ recently-active**, deduped by path |
| C2 | Health formula | **red = any high-bucket (sev≥4) open item; yellow = any open item; else green** | **LOCKED (founder, 2026-07-08): tripped-breaker stays RED (threshold 4).**
| C3 | Empty-diff signal | **`git status --porcelain` per running session on the 15m sweep** (ground truth, not a proxy) |
| C4 | Fleet storage | **Derive-on-demand** (no materialized table) |
| C5 | Anomaly cadence | **Ride the existing 15m infra sweep** (no new schedule) |
| C6 | PR count in health | **Best-effort with timeout; failure → unknown/0, never blocks the row** |

Flagged genuine picks: **C2's HIGH_THRESHOLD** (is a stalled-loop breaker "red" or "yellow"? — I put
tripped-breaker in red because a broken loop stops shipping) and **C3's cost ceiling** (git-status per
running session is fine at personal scale; revisit if concurrency grows). Everything else follows the
locked constraints.
