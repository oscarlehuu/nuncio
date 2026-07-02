# Phase 3 — Task Inbox UI

**Status:** In progress · **Depends on:** Phase 2 (tasks API)

## Scope

- **`/tasks` route** with a sidebar entry: the delegation surface. Composer at top (prompt · project picker · Work locally / New worktree mode picker · provider/model picker — the same pickers the home composer uses), lanes below.
- **Lanes:** Queued · Running · Needs you · Done (+Failed). "Needs you" = RUNNING task whose session has pending input (server-derived flag on the task row).
- **Task card:** title/prompt, project, status, verify outcome chip when done, one tap into `/session/:id` once the session exists; cancel (queued), retry (terminal).
- **Data:** poll `GET /api/tasks` on the same cadence the session list already uses; no new streaming path.

## Out of scope

- Grid integration (a "task lane" in the grid) — revisit after real usage.
- Editing a queued task in place (cancel + re-create covers it).

## Verify

- Component specs: lane bucketing, card actions, composer submit payload.
- Real-browser pass: create a task from the composer, watch it move Queued → Running → Done with the verify chip.
