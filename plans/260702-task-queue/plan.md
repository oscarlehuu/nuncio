# Task Queue — From Workbench to Orchestrator

**Status:** Planning · **Depends on:** [260702-runtime-durability](../260702-runtime-durability/plan.md) Phase 1 (a queue is pointless if a restart loses runs) · benefits from [260701 Phase B](../260701-desktop-daemon-mobile/phase-b-daemon-relay.md) but does not block on it
**Thesis:** Today the unit you delegate is a *session* — you set up workspace, provider, prompt, and you babysit the run. The next altitude is a *task*: prompt + project + options handed to nuncio, which prepares the workspace, runs the agent, verifies the result, and only surfaces when a human is needed. The grid answers "which agent needs me?"; the queue makes agents need you less.

## Decisions (locked — founder, 2026-07-02)

| Decision | Choice | Why |
|----------|--------|-----|
| Worktree per task | **Optional, per task — never forced** | Reuse the existing workspace mode picker semantics ("Work locally" \| "New worktree"). Auto-creating a worktree is an option the task carries, not queue policy. |
| Verifier gate | **Annotate, don't block** | After a turn ends, run the project's check command (configurable per project) and append a `verify.result` event. The FSM still goes to `IDLE`; UI shows a verified/failing chip (and grid border tint). Blocking the FSM on a flaky test suite would make the queue lie. |
| Provider scope | **Pi first-class, others best-effort** | Founder direction: Pi stability + dogfooding; no provider expansion. |
| Queue scope v1 | **Single machine** | Per-machine concurrency cap. A hub-wide (cross-machine) queue is a later phase — the grid's per-slot machine binding already proves the routing primitives. |

## Phase sketch

Phase docs are authored when each phase starts (keep planning honest to what Phase 1 durability teaches us).

| Phase | Focus |
|-------|-------|
| 1 | **Verifier gate, no queue yet** — shipped, see [phase-1-verifier-gate.md](./phase-1-verifier-gate.md): `.nuncio/verify` script or `NUNCIO_VERIFY_COMMAND` setting, run on turn end, `verify_start`/`verify_result` events, chip in session header + grid tiles. |
| 2 | **Tasks table + runner** — enqueue(task) → create session (optionally in a fresh worktree per the task's flag) → run → verify → outcome on the task row. Concurrency cap, simple FIFO, explicit retry (manual re-enqueue first; auto-retry policy only if manual proves annoying). |
| 3 | **Task inbox UI** — home/grid integration: queued/running/needs-you/done lanes, one tap from "needs you" into the session. |

## Adjacent scope endorsed (2026-07-02), not scheduled

- Per-session permission profile — `NUNCIO_CODEX_RUNTIME_MODE` is a global setting today; it should become a session (then task) attribute.
- Cost/token tracking per session — observability column + daily digest; also the data for judging provider efficiency later.
