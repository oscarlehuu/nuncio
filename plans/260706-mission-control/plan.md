# Mission Control — North-Star Plan for the True ADE

**Status:** North-star (founder brainstorm, 2026-07-06). Rungs unlock in order; a rung's phase
doc is authored only when it starts. Near-term execution is still governed by the active lanes
([260702-runtime-durability](../260702-runtime-durability/plan.md),
[260702-task-queue](../260702-task-queue/plan.md)) — those two plans *are* rungs 0–1 here.
**Thesis:** When the founder drives N projects × M agent sessions at once, the scarce resource is
founder attention, not agent capacity. A true ADE is an **attention router**: every rung below
either raises decisions-per-minute-of-attention or feeds a rung that does. The cockpit metaphor
is literal — autopilot (loops), heartbeat, radar (attention queue), fuel gauges (budgets),
flight recorder (timeline), chief-of-staff (dispatcher).
**Detail:** this file stays thin on purpose (sequencing + decisions). The full design material
per rung — loop anatomy and families, heartbeat layers, attention-queue ranking, fleet health,
dispatcher v1→v2 — lives in [cockpit-map.md](./cockpit-map.md); each rung's phase doc distills
from there when the rung starts (first: [phase-1-verify-feedback.md](./phase-1-verify-feedback.md)).

## The primitive ladder

Each rung raises the unit of delegation by one altitude. UI displays at the highest altitude
available and drills down.

| Primitive | Definition | Status |
|-----------|-----------|--------|
| **Session** | One agent run; founder babysits | shipped |
| **Task** | Prompt + project + options; nuncio owns workspace/run/verify | in flight (260702-task-queue) |
| **Pipeline** | 2–3 chained tasks with roles (implement → verify → cross-engine review → PR) | rung 2+ |
| **Loop** | Standing task: `{goal, trigger, budget, stop condition, escalation policy}` | rung 2 |
| **Mission** | Portfolio-level objective spanning projects, made of loops/tasks | rung 3+ |

## Sequencing rule (compounding)

Prefer rungs that let **nuncio build nuncio**. Once loops + verify-feedback exist, "improve
nuncio" becomes an overnight loop and every later rung ships faster. This outranks per-rung
value comparisons.

## Rungs

Done-when criteria are dogfood criteria — a rung is done when the founder has *lived* it, not
when tests pass.

| Rung | Focus | Ships | Done when |
|------|-------|-------|-----------|
| **0 — Foundation** | Durability + verifier gate | restart reconciliation, event-log hygiene, `verify_result` events + chips | a server restart loses nothing the founder would miss |
| **1 — Task lane** | Runner + inbox + **verify-feedback loop** | on `verify_result` fail, auto-steer the session with the failure output, max N rounds, then surface "needs you" (FSM still annotate-don't-block; retry lives in the task runner) | a task self-fixes a red verify with zero founder input |
| **2 — Autopilot** | Cron + event triggers, loop primitive, project entity | scheduler on the daemon (state in SQLite, restart-safe); loop record with the 5 fields above; forge-webhook triggers ("new issue labeled `agent` → enqueue triage task"); project as first-class entity (per-project verify command, worktree policy, default engine, context files) | one maintenance loop runs nightly for a week, inside budget, all output via worktree + PR |
| **3 — Attention** | Approvals inbox, heartbeat, diff review, fleet home | one ranked queue of everything needing the founder (permissions, verify-dead-after-N-rounds, PRs, tripped breakers) with push + one-tap approve; heartbeat in 3 layers — infra self-check (zombie sessions, stale worktrees, **expiring CLI credentials**), fleet reconciliation on a cadence, human digest (morning summary / evening pre-flight); per-session diff view with comment-to-steer (select hunk → steer with file:line context); home screen = fleet view (project health rows) + attention queue | founder drives a full working day from the phone only |
| **4 — Intelligence** | Observability, nuncio-as-MCP, dispatcher | token/cost + verify-pass-rate + steer-count per session/task/provider/project; global timeline ("what happened while I slept") feeding the digest; nuncio's own API wrapped as an MCP server (agents can list sessions, read verify results, enqueue tasks); dispatcher v1 = deterministic rules (retry, escalation, digest), v2 = an agent session granted the nuncio MCP — **proposes, founder approves** | dispatcher drafts tomorrow's queue from open work and yesterday's results; founder approves in one tap |

Cross-rung thread — **checkpoint & rewind**: auto-commit the worktree at each turn end; UI can
roll back to turn N and steer from there. Lands opportunistically once rung 1 exists (the event
log + worktree plumbing is already in place).

## Decisions

**Inherited, locked (founder, 2026-07-02, from the task-queue plan):** worktree per task is
optional per task, never forced · verifier annotates, never blocks the FSM · Pi first-class,
others best-effort · single-machine queue v1.

**Proposed here — each needs a founder lock when its rung starts, none are decided yet:**

| Proposal | Default suggested | Rung |
|----------|-------------------|------|
| Loop record shape | exactly `{goal, trigger, budget, stop, escalation}` — resist extra fields | 2 |
| Loop write policy | loop output always lands via worktree + PR, never a direct branch write | 2 |
| Budgets & breakers | daily global token budget + per-loop cap; breaker pauses a loop after 3 consecutive failed runs + notifies | 2 |
| Anomaly heuristics | long-running session with empty diff, loop burning budget with no verify progress → radar | 3 |
| Dispatcher authority | proposes-only until founder explicitly widens it | 4 |
| Direction test #6 | add "Attention test — does this raise decisions-per-minute-of-attention?" to `product-vision.md` | any (doc edit needs explicit founder sign-off) |

## Guardrails (ADR compliance — these are how, not whether)

- **Restart test:** cron schedules, loop state, breaker state, attention queue all live in
  SQLite and rebuild from the log. A cron job that forgets its schedule after reboot betrays
  pillar 4.
- **Engine test:** dispatcher, loops, and pipelines touch engines only through `AgentProvider`.
  No `if (provider === 'pi')` at the orchestration layer (ADR-004).
- **Not an LLM harness:** the dispatcher is an ordinary provider session; nuncio still never
  calls a model API directly. Intelligence enters only through sessions nuncio hosts.
- **Engine scope:** ADR-011 still governs — this plan adds zero engines. Observability data is
  what later makes the "when to add Claude" call evidence-based.
- **Phone test:** approvals, digest, diff review, and fleet home must all work from the iPhone
  over Tailscale — they are the point of rung 3.

## Non-goals

- No general workflow engine (n8n-style) — loops and pipelines stay opinionated and small.
- No DAG — straight 2–3 step chains until real usage demands more.
- No editor — diff review is for reviewing, not hand-editing (non-goal "not an IDE" holds).
- No multi-tenant, no hosted mode (ADR-001 holds).

## Open questions (founder)

1. Direction test #6 wording — approve, amend, or drop?
2. Budget defaults — what daily token/cost ceiling feels right to start?
3. Digest delivery — push notification, in-app only, or both?
4. Fleet home — **RESOLVED (founder, 2026-07-08): Fleet replaces the Workbench as the landing surface; the Workbench grid becomes the per-project drill-down.** **Amended 2026-07-08 after dogfood:** Fleet UI removed from Home because the global pinboard and project drill-down mismatch made fleet-row → filtered-grid semantically empty at current scale. The `/fleet` data layer is retained; a real project page is the future re-entry point.
