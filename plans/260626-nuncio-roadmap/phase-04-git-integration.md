# Phase 04 — Git Integration

**Status:** Workspace subset shipped · **Depends on:** Phase 3

## Scope
- Workspace per session under `~/.nuncio/workspaces/` — **done**
- Branch `nuncio/<id>-<slug>` — **done**
- Pi `cwd` = workspace — **done**
- Project + branch pickers in UI — **done**
- Commit + `gh pr create` — **deferred**
- Worktree cleanup on archive — **deferred** (kept for review/merge)

## Agent ownership
- **A:** `apps/server/src/git/**`
- **B:** session + pi-agent wiring
- **C:** `project-picker.tsx`, `branch-picker.tsx` UI
