# Phase 2 — Tasks Table + Runner

**Status:** Shipped (2026-07-02, TDD) · **Depends on:** runtime-durability Phase 1 (restart honesty), verifier gate (outcome source)

## Scope

- **`tasks` table** — prompt, provider/model/options, project + base branch, `use_worktree` flag (locked decision: optional per task, never forced), workspace, linked `session_id`, status, outcome JSON, timestamps.
- **Statuses:** `QUEUED → RUNNING → DONE | FAILED`, plus `CANCELLED` (queued tasks only). "Needs you" is derived, not stored — a RUNNING task whose session is waiting on input.
- **Runner:** FIFO pump inside the server. Claims the oldest QUEUED task (atomic `UPDATE … RETURNING`), creates the session through the existing `SessionsService.create` path (worktree per the task's flag), awaits the run *including the verifier gate*, then records the outcome: final session status + last `verify_result`.
- **Concurrency cap:** `NUNCIO_TASK_CONCURRENCY` setting, default 1.
- **Boot reconcile:** tasks stuck RUNNING when the daemon died are marked FAILED with reason `daemon_restart` (their sessions are already reconciled to IDLE by the durability sweep; retry re-enqueues).
- **Retry:** explicit only — `POST /api/tasks/:id/retry` clones a terminal task into a fresh QUEUED task.
- **API:** `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/retry`, `DELETE /api/tasks/:id` (terminal states only).

## Out of scope

- Cross-machine (hub) queue, auto-retry policies, task dependencies, scheduling.

## Verify

- Repository specs: FIFO claim order, atomic claim, status guards.
- Service specs: enqueue→run→DONE with verify outcome; failure path; cancel; retry clone; concurrency cap respected; boot reconcile.
- Controller specs: param forwarding + guards.
