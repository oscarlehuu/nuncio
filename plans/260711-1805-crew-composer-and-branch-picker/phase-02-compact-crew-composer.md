# Phase 2 — Compact Crew composer

**Priority:** P0 · **Status:** Complete

## Context

- Composition: `apps/web/src/components/home-view.tsx`
- State: `apps/web/src/components/crew/use-crew-composer.ts`
- Current controls: `crew/execution-mode-picker.tsx`, `crew/crew-profile-picker.tsx`,
  `crew/resolved-crew-preview.tsx`, and `crew/crew-worktree-indicator.tsx`.

## Requirements and architecture

- Replace `ExecutionModePicker` with a focused `CrewModeToggle` built on the shared Radix `Switch`.
  Visible label `Crew`; `checked=false` maps to `solo`, `checked=true` to `crew`; keep a compact visual
  track with a keyboard-visible focus ring and a touch hit area appropriate at 390 px.
- Keep the state machine in `useCrewComposer` (`solo | crew`); change only the toolbar adapter so
  profile refresh, cancellation, resolution, double-submit lock, and Solo default remain intact.
- Rebuild `CrewProfilePicker` on the shared DropdownMenu radio primitives: compact trigger, profile
  name truncation, current selection semantics, loading/disabled state, and keyboard selection.
- Zero profiles: render a compact `Set up Crew` link/action to
  `/settings?section=crew-profiles`; do not render a fake selectable “No profiles” value.
- In `ResolvedCrewPreview`, return no large card for the no-profile state. Keep compact actionable
  errors/needs-setup and truthful ready evidence; loading may be represented inline by the profile
  control rather than an extra block.
- Remove `CrewWorktreeIndicator` from the context row (and delete it if unused). Render the workspace
  separator + WorkspaceModePicker only in Solo. Continue passing the selected `baseBranch` through
  `resolveCrewProfile` and `createCrewTask`; do not add a Crew local-work option.

## TDD and exact files

1. RED: replace `crew/execution-mode-picker.spec.tsx` with toggle semantics: role switch, default off,
   one click emits Crew, second emits Solo, disabled/focus behavior.
2. RED: add `crew/crew-profile-picker.spec.tsx` for compact selection, truncation/accessibility,
   loading, and zero-profile setup action.
3. RED in `home-view.spec.tsx`: Solo default has ModelPicker + workspace choice; Crew on swaps in the
   inline profile control, removes the visible worktree label/trailing separator, retains selected
   branch, re-resolves on branch changes, and creates with the exact branch/profile once.
4. RED in `resolved-crew-preview.spec.tsx`: null/no-profile does not create a large notice; errors,
   needs-setup link, and ready roster remain truthful.
5. GREEN: update/rename the four Crew controls and `home-view.tsx`; avoid provider/model branches.

## Risks / success

- The switch must read as “enable Crew,” not an ambiguous status light; use visible text + `aria-label`.
- Removing the worktree label is presentation-only: tests must pin `baseBranch` payload and server
  fixed-worktree behavior so audit cannot accidentally turn Crew into Work locally.
- Success: the toolbar is one quiet line on desktop/390 px, empty profile state is small/actionable,
  and no model/profile/workspace control contradicts the active mode.
