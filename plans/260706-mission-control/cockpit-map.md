# Cockpit Map — Design Material per Rung

Companion to [plan.md](./plan.md). The plan stays thin (thesis, sequencing, locked vs proposed
decisions); this file holds the full design material from the founder brainstorm (2026-07-06) so
agents starting a rung inherit the thinking, not just the row. Nothing here is locked — when a
rung starts, its phase doc distills from this and the founder locks what needs locking.

## The reframe everything hangs on

With N projects × M sessions, the scarce resource is founder attention. A feature is good if it
raises decisions-per-minute-of-attention; a dashboard that demands staring fails, a push with a
one-tap approve passes. (Proposed as direction test #6 in product-vision.md — needs founder
sign-off, see plan.md proposals table.)

## Rung 1 — Task lane (verify-feedback: SHIPPED in this branch)

See [phase-1-verify-feedback.md](./phase-1-verify-feedback.md) — the loop, settings, events,
boot resume, task settlement. Cross-rung thread that becomes possible now: **checkpoint &
rewind** — auto-commit the worktree at each turn end; UI rolls back to turn N and steers from
there. The event log is the timeline; the worktree commit is the state snapshot.

## Rung 2 — Autopilot

**Loop primitive.** A loop is a standing task with exactly five fields:
`{goal, trigger, budget, stop condition, escalation policy}`. Resist extra fields.

**Trigger types:** cron (nightly), event (forge webhooks already normalize vocabulary — "new
issue labeled `agent` → enqueue triage task" is nearly free), heartbeat tick.

**Four loop families worth shipping first:**
- *Maintenance*: dependency bumps, flaky-test hunting, lint debt, docs drift.
- *Watch*: CI red → auto-fix task; reviewer comment → proposed steer.
- *Improvement*: "raise coverage on module X to 80%, then stop" — stop condition does real work.
- *Overnight batch*: queue drains while the machine is idle and no human is contending.

**Budgets & breakers:** daily global token/cost ceiling + per-loop cap; a breaker pauses a loop
after 3 consecutive failed runs and notifies. Loop output always lands via worktree + PR, never
a direct branch write (proposed default, plan.md table).

**Project entity:** per-project config (verify command, worktree policy, default engine, context
files) becomes a first-class record — loops need it, and rung 3's fleet view displays it.

## Rung 3 — Attention

**Radar / attention queue:** ONE ranked queue of everything needing the founder — permission
requests, verify-dead-after-N-rounds, PRs awaiting review, tripped breakers — ordered by urgency
× project importance. Anomaly heuristics feed it: long-running session with an empty diff; loop
burning budget with no verify progress.

**Heartbeat, three layers (don't merge them):**
- *Infra self-check*: zombie sessions (RUNNING but last event hours old), stale worktrees,
  **expiring CLI credentials** (a dead `glab` token at 3am kills the whole night's queue).
- *Fleet reconciliation*: the restart-reconciliation pass, run on a cadence, not just at boot.
- *Human digest*: morning ("what shipped overnight, what's blocked on you, what it cost") and
  evening pre-flight ("is tonight's queue loaded?"). The rhythm is what turns a tool into an
  environment.

**Diff review + comment-to-steer:** per-session/task diff view of the worktree; select a hunk,
type a note, it becomes a steer with file:line context. The phone version is the killer feature.

**Fleet home:** project health rows — health = f(CI, PRs waiting on founder, running sessions,
verify streak, last activity) — green cruising / yellow needs review / red needs you; attention
queue beside it. Current Workbench grid becomes the drill-down inside a project. Managing
AGENTS.md/context files per repo belongs here too (today it fails the phone test).

## Rung 4 — Intelligence

**Observability first** — it's the data layer the rest reads: token/cost, verify pass rate,
steer count per session/task/provider/project; a global timeline ("what happened while I slept")
that the digest renders. After months of data, "which engine for which repo" and "when to add
Claude" (ADR-011) become evidence-based calls.

**Nuncio-as-MCP:** wrap nuncio's own API as an MCP server — any hosted agent can list sessions,
read verify results, enqueue tasks. Nuncio goes from *host* to *platform*; agents coordinate
through it. This does not violate "not an LLM harness": nuncio still never calls a model API.

**Dispatcher:** v1 is deterministic rules (retry, escalation, digest assembly) — no model. v2 is
an ordinary provider session granted the nuncio MCP: it drafts tomorrow's queue from open work
and yesterday's results, **proposes, founder approves** — authority widens only when the founder
explicitly says so.

## Sequencing heuristics (why this order)

1. **Compounding first:** prefer rungs that let nuncio build nuncio — loops + verify-feedback
   make "improve nuncio" an overnight loop, so they front-load every later rung.
2. **Data before intelligence:** dispatcher and digest read what observability and the event
   timeline write; building them first would mean building them blind.
3. **Dogfood gate:** a rung is done when the founder has lived it (plan.md done-when column),
   not when its suite is green.

## Anti-scope (protecting the thin waist)

No n8n-style general workflow engine · no DAG until straight 2–3 step chains demonstrably fail ·
no editor (diff review reviews; Cursor edits) · no multi-tenant · zero new engines (ADR-011).
