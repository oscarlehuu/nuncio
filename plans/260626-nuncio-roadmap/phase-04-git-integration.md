# Phase 04 — Git Integration

**Status:** Planned · **Depends on:** Phase 3

## Scope
- Workspace per session under `~/.nuncio/workspaces/`
- Branch `nuncio/<id>-<slug>`
- Pi `cwd` = workspace
- Commit + `gh pr create`

## Agent ownership
- **A:** `apps/server/src/git/**`
- **B:** session + pi-agent wiring
- **C:** `repo-picker.tsx` UI
