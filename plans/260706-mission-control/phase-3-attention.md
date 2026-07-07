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
