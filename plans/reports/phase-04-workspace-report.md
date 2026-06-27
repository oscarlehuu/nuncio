# Phase 04 — Git Worktree Workspace Report

**Status:** workspace subset shipped · **Date:** 2026-06-27

## What shipped

- **`GitService`** (`apps/server/src/git/`): `listProjects()`, `listBranches(path)`, `createWorktree()` via real `git` subprocess; `resolveRepoRoot()` with macOS path normalization.
- **REST:** `GET /api/projects`, `GET /api/projects/branches?path=`.
- **Sessions schema:** `project_path`, `base_branch`, `worktree_path`, `branch` columns (CREATE TABLE + guarded ALTER migration).
- **Create flow:** generate session id → create worktree `nuncio/<id>-<slug>` at `NUNCIO_WORKSPACES_DIR/<id>` → persist → `provider.run({ cwd: worktreePath })`.
- **Pi:** `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) })` when workspace set.
- **Frontend:** `ProjectPicker` (scanned roots + custom path), `BranchPicker`, composer wiring, repo/branch badges in session detail + sidebar.

## Locked decisions

- New branch per session (`nuncio/<id>-<slug>` from picked base) — safest + unlimited parallel sessions on same base.
- Archive keeps worktree + branch (cleanup deferred).
- Server-driven project list (no browser FS API).

## Verify

```bash
export NUNCIO_PROJECT_ROOTS=~/Desktop/Oscar
export NUNCIO_FORCE_MOCK=1   # optional for dev without Pi auth
bun run build
bun run test && bun run --filter @nuncio/server test:e2e
bun run --filter @nuncio/web test && bun run lint
bun run dev
# UI: pick project + branch → create session → check ~/.nuncio/workspaces/<id>
```

## Deferred

- `gh pr create` from worktree branch
- Explicit worktree/branch cleanup on archive
- File-backed Pi `SessionManager.create(cwd)` for restart revive

## Unresolved

- None for workspace subset.
