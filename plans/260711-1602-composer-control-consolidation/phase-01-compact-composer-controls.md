# Phase 1 — Compact composer controls

**Priority:** P0 · **Status:** Pending

## Context

- Visual evidence: `/var/folders/bk/xpt31n757f56d1j7t7qvjrcw0000gp/T/codex-clipboard-bc6b4715-e490-499e-8f01-15b8ebeca998.png`
- Composer: [`apps/web/src/components/home-view.tsx`](../../apps/web/src/components/home-view.tsx)
- Mode control: [`apps/web/src/components/crew/execution-mode-picker.tsx`](../../apps/web/src/components/crew/execution-mode-picker.tsx)
- Shared picker: [`apps/web/src/components/model-picker.tsx`](../../apps/web/src/components/model-picker.tsx)

## Requirements and architecture

- Preserve `role="radiogroup"`, `role="radio"`, `aria-checked`, keyboard focus, and Solo default.
- Reduce the mode control to a quiet, content-height segmented toggle; selected state uses subtle
  fill/contrast, not a separate large card. Keep the icons and labels discoverable.
- Keep one ModelPicker implementation and menu. Move trigger density into shared base props so chat
  and engine+model modes use the same compact height, icon slot, label typography, chevron, truncation,
  and accessible name. Do not duplicate provider-specific markup.
- Apply the compact trigger grammar to Home, Grid, loop create/edit, held subagents, subagent model
  settings, and Crew profile bindings. Preserve context-specific value semantics (`value` vs pair mode,
  inherit/provider-default rows, options/effort, recents, and modal scrolling).

## TDD and files

1. RED: update [`home-view.spec.tsx`](../../apps/web/src/components/home-view.spec.tsx) to pin Solo
   default, mutual exclusivity, compact control markers, and model/profile replacement by mode.
2. RED: extend [`model-picker.spec.tsx`](../../apps/web/src/components/model-picker.spec.tsx) to assert
   the same compact trigger grammar for chat and pair mode without changing menu selection behavior.
3. GREEN: refine `execution-mode-picker.tsx` and `model-picker.tsx`; keep visual sizing in those shared
   components instead of scattered descendant selectors.
4. GREEN: adopt the shared compact prop in `home-view.tsx`, `grid-slot-composer.tsx`,
   `create-loop-dialog.tsx`, `loop-settings-tab.tsx`, `subagent-row.tsx`,
   `subagent-models-settings-section.tsx`, and `crew/edit-crew-profile-dialog.tsx`.
5. Update the closest call-site specs (`grid-slot-composer.spec.tsx`, `create-loop-dialog.spec.tsx`,
   `subagent-models-settings-section.spec.tsx`, `crew/crew-profiles-settings-section.spec.tsx`) only
   for observable trigger behavior; avoid snapshots and class-only overfitting.

## Success criteria / risks

- At 390 px and desktop widths, controls remain one compact, horizontally scrollable row with no
  clipping or oversized Solo/Crew block; focus rings remain visible in both themes.
- Risk: shrinking touch targets too far. Keep at least a 36 px interactive hit area even if the visual
  pill is smaller, and prove keyboard/touch operation in Level 5.

