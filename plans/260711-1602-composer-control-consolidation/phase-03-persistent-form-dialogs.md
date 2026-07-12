# Phase 3 — Persistent form-dialog focus boundary

**Priority:** P0 · **Status:** Pending

## Context

- Primitive: [`apps/web/src/components/ui/dialog.tsx`](../../apps/web/src/components/ui/dialog.tsx)
- Form dialogs: Crew profile, loop creation, project config, forge new issue, PR review, and PR merge.

## Requirements and architecture

- Radix Dialog already supplies modal focus trapping. Add one explicit shared `DialogContent` option
  for **outside-dismiss behavior**, defaulting to current behavior for compatibility.
- When enabled for a form, prevent pointer/focus interaction outside from closing it. Do not intercept
  `Escape`, the top-right Close button, or explicit Cancel actions.
- Enable the option only in:
  `crew/edit-crew-profile-dialog.tsx`, `create-loop-dialog.tsx`,
  `edit-project-config-dialog.tsx`, `forge/new-issue-dialog.tsx`,
  `forge/pr-review-bar.tsx`, and `forge/pr-merge-bar.tsx`.
- Leave `chat-image.tsx` and `ui/command.tsx` untouched. Confirmation-only delete/revoke dialogs and
  folder browsing remain current behavior unless later requested.

## TDD and files

1. RED: add a focused primitive spec beside `ui/dialog.tsx` proving outside interaction does not call
   `onOpenChange(false)` when opted in, while Escape and explicit Close still do.
2. RED: add behavioral coverage to `create-loop-dialog.spec.tsx`,
   `crew/crew-profiles-settings-section.spec.tsx`, and `forge/pr-merge-bar.spec.tsx`; add direct specs
   for new issue/review/project config where no focused coverage exists.
3. GREEN: implement the opt-in by composing Radix outside-interaction handlers without swallowing any
   caller handler. Apply it to the six form surfaces only.
4. Browser-check initial focus, repeated Tab/Shift+Tab containment, backdrop click persistence,
   Escape close, Cancel close, and reopening with a clean/expected draft.

## Success criteria / risks

- Accidental backdrop clicks never discard an in-progress form; keyboard users cannot tab behind it.
- Nested ModelPicker menus remain scrollable/selectable inside Crew/loop dialogs.
- Risk: treating a portalled picker as “outside.” Verify pair-mode selection in Level 5 before merge;
  if needed, distinguish Radix branch content rather than weakening the persistence rule.

