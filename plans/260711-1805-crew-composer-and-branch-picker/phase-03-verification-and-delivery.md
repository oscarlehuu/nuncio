# Phase 3 — Verification and delivery

**Priority:** P0 · **Status:** Complete

## Verification

1. Run targeted Git service, branch picker, Grid, Home, Crew toggle/profile/preview, and mobile branch
   specs; record the intended RED failures before implementation and exact GREEN pass counts after.
2. Run server unit/e2e for `/api/projects/branches`, web full test/build/lint, mobile check, then
   `bun run gate:full`. Never hide or weaken a failure.
3. Level 5 with Mock provider + system Chrome in dark mode and light spot-check:
   - Home desktop and 390 px: Crew off/on, compact toolbar, profile selection/setup action, no overflow.
   - Context row: selected branch remains visible; no Crew worktree text or dangling separator.
   - Workbench local: local + remote-only branches visible and selectable.
   - Hub Workbench: selected machine supplies projects and branches from the same `/m/<machine>` base.
   - Crew ready/no-profile/needs-setup states; send payload keeps exact selected branch.
4. Assert keyboard operation/focus for switch and profile menu, narrow `scrollWidth <= clientWidth`,
   and clean browser console/network output. Save dark desktop/mobile before/after screenshots.

## Review and delivery

- Review for qualified-ref correctness, generated-branch filtering, hub routing, Crew fixed-worktree
  invariants, accessible control names, and provider neutrality.
- Add a user-facing patch changeset; docs impact is likely none unless visible Crew creation copy in
  README no longer matches the shipped UI.
- Commit focused paths, push `fix/crew-composer-and-branch-picker`, open a ready PR to `dev`, wait for
  green CI, merge, and verify the resulting Nuncio Dev signed/notarized release assets.

## Definition of done

- Every audited branch surface uses the repaired shared contract; no per-surface hardcoded branch list.
- Crew creation is visually compact and operationally unchanged; visual evidence and exact test/review/
  PR/release results are included in the final report.

## Result

- Focused regression: Git service 62/62; affected web surfaces 41/41.
- Full verification: `bun run gate:full` green, including 39 server e2e, 884 web tests, and Level-5
  system-Chrome smoke for desktop, 390 px, Solo delegation, branch selection, and the full Crew flow.
- Two independent review findings were fixed before delivery: divergent remote refs remain selectable,
  and Crew setup links preserve the hub machine base path. Docs impact: none beyond this plan/report.
