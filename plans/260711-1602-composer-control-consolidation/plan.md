# Composer Control Consolidation

**Status:** Planned · **Base:** `origin/dev` · **Target:** `dev`

## Outcome

Make the composer read as one quiet control system: a small Solo/Crew segmented toggle, one
compact ModelPicker grammar everywhere, no per-session permission selector, trusted local defaults,
and form dialogs that keep focus until the user explicitly closes them.

## Locked decisions

- Solo remains the default. Solo/Crew remains an accessible radio group, but the visual control is
  a compact segmented toggle (no large boxed/touch-card treatment).
- Extend the existing shared `ModelPicker`; do not fork menus or provider-specific triggers.
- Remove the Codex approval-mode selector and its prop/state plumbing from Home, Grid, and Session.
  Keep transcript approval cards because advanced Settings overrides may still request a decision.
- Codex keeps `full-access` as default. Claude's default and invalid-value fallback become
  `bypassPermissions`; Settings still offers `default`, `acceptEdits`, `plan`, and bypass overrides.
- Form dialogs trap focus and ignore outside/backdrop clicks. Cancel, Close, and Escape still close.
  Image preview and command palette keep their current dismissal behavior.

## Phases

| Phase | Scope | Detail |
|---|---|---|
| 1 | Compact execution toggle + shared model-trigger grammar | [phase-01-compact-composer-controls.md](./phase-01-compact-composer-controls.md) |
| 2 | Remove session permission UI + trusted defaults | [phase-02-trusted-provider-defaults.md](./phase-02-trusted-provider-defaults.md) |
| 3 | Persistent form-dialog focus boundary | [phase-03-persistent-form-dialogs.md](./phase-03-persistent-form-dialogs.md) |
| 4 | Browser proof, review, and delivery | [phase-04-verification-and-delivery.md](./phase-04-verification-and-delivery.md) |

## Dependencies and guardrails

- TDD order per phase: failing behavioral spec → minimum implementation → refactor.
- Preserve provider-neutral contracts and the existing model catalog/menu behavior.
- Do not change image-preview or command-palette dismissal semantics.
- User-facing patch changeset required; docs must match Claude's new default.
- No unresolved questions: current source supports the requested behavior without a contract conflict.

