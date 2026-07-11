# Phase 1 — Shared branch discovery

**Priority:** P0 · **Status:** Complete

## Surface audit

- Server source: `apps/server/src/git/git.service.ts` → `/api/projects/branches` in
  `apps/server/src/git/git.controller.ts`.
- Web consumers: `BranchPicker` in `home-view.tsx` and `grid-slot-composer.tsx`.
- Mobile consumer: `apps/mobile/src/lib/crew-projects.ts` uses the same endpoint.
- Server consumers: session project validation/default resolution and
  `crew/crew-git-workspace.adapter.ts` also call `listBranches()`.

## Requirements and architecture

- Replace the local-only enumeration with one deterministic query over `refs/heads` and
  `refs/remotes`; exclude symbolic remote HEAD rows and deduplicate only refs at the same commit.
- Keep local names (`main`, `feature/x`). Represent remote-only branches by valid refs
  (`origin/feature/x`) so both ordinary worktree start-points and Crew's strict `rev-parse` succeed.
- Prefer a local default/current row when present; otherwise mark the matching remote default.
  Preserve alphabetical stable output and the existing `BranchDto` shape.
- Do not fetch over the network in a picker request; stale/missing remote refs remain a truthful
  repository-state issue, not hidden latency or credential work.
- Add optional `base` to web `fetchBranches`, optional `apiBase` to `BranchPicker`, and pass
  `remoteBase` from Grid. Home remains same-origin; mobile already routes through its configured API.

## TDD and exact files

1. RED in `apps/server/test/unit/git/git.service.spec.ts`: create a repo with local `main`, remote
   `origin/main`, remote-only `origin/feature/remote`, and `origin/HEAD`; assert dedupe, exclusion,
   valid names, default/current flags, and stable order.
2. RED in `apps/web/src/components/branch-picker.spec.tsx`: pin remote-ref rendering/selection and
   filtering of generated Nuncio refs without resetting a valid remote selection.
3. RED in `apps/web/src/components/grid-slot-composer.spec.tsx`: after selecting machine `studio`,
   assert BranchPicker receives `/m/studio` API base alongside ProjectPicker.
4. Add a focused `apps/web/src/lib/projects.spec.ts` request assertion for encoded path + API base;
   extend `apps/mobile/src/lib/crew-projects.spec.ts` to accept remote branch names unchanged.
5. GREEN: update `git.service.ts`, `projects.ts`, `branch-picker.tsx`, and
   `grid-slot-composer.tsx`; keep endpoint/controller/DTO unchanged.

## Risks / success

- Multiple remotes may expose same suffix: keep qualified remote names rather than guessing.
- `origin/nuncio/...` can bypass the current local-only generated-branch regex; cover qualified
  generated refs and keep them out of user base choices on web/mobile.
- Success: Workbench/Home/mobile show every on-disk usable branch, remote Grid queries its selected
  machine, and selecting a remote-only base reaches session/Crew creation unchanged.
