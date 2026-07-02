---
"nuncio": minor
---

Added a task queue — the delegate-and-forget layer above sessions. Queue a task from the new Tasks page (sidebar → Tasks): prompt, project, an optional fresh worktree per task, and a model. A FIFO runner (concurrency via the `NUNCIO_TASK_CONCURRENCY` setting, default 1) starts the session, waits for the run and its post-turn checks, and records the outcome on the task. The inbox shows Needs you / Running / Queued / Done lanes with verify-outcome chips, cancel for queued tasks, retry for finished ones, and a one-tap jump into the session. Tasks interrupted by a daemon restart are marked failed with an explicit reason; queued work simply resumes on boot.
