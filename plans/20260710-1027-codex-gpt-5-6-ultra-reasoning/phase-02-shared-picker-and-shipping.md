# Phase 2 — Shared picker and shipping

## Context links

- [Overview](./plan.md)
- [Phase 1](./phase-01-codex-catalog-and-adapter.md)
- `packages/core/src/model-picker-catalog.ts`
- `apps/web/src/components/model-picker.tsx`
- `apps/web/src/components/model-effort-slider.tsx`

## Overview

**Priority:** High
**Status:** Complete
**Depends on:** Phase 1
**Purpose:** Prove arbitrary per-model effort choices in the shared client layer and prevent stale Ultra selections from leaking to an unsupported model.

## TDD implementation

1. **RED:** in `packages/core/src/model-picker-catalog.spec.ts`, model Sol with Ultra and Luna without it. Assert `mergeOptionsForModel(Luna, { reasoningEffort: "ultra" })` returns Luna's advertised default, while Sol retains Ultra.
2. **GREEN:** make `mergeOptionsForModel()` validate every select value against its descriptor choices, drop unknown option keys, preserve valid booleans/strings, and fall back via existing descriptor defaults. No provider ids or effort-name special cases.
3. **RED/characterization:** in `apps/web/src/components/model-picker.spec.tsx`, render both GPT-5.6 models, verify the six-step Sol slider can select Ultra, switch to Luna and verify Ultra is absent/reset, and confirm the menu stays open while dragging.
4. Change `model-picker.tsx` or `model-effort-slider.tsx` only if that spec exposes a real generic defect. The current slider already accepts arbitrary ordered choices; avoid a Codex-only control.
5. Confirm `packages/core/src/api.spec.ts` still round-trips `modelOptions`; no API/session DTO change is expected.

## Files

**Required:**

- `packages/core/src/model-picker-catalog.ts`
- `packages/core/src/model-picker-catalog.spec.ts`
- `apps/web/src/components/model-picker.spec.tsx`
- `README.md`
- `.changeset/<generated>.md` via `bun run add-changeset patch "Added GPT-5.6 Codex models with model-specific Ultra reasoning choices."`

**Only if a failing generic UI spec requires it:**

- `apps/web/src/components/model-picker.tsx`
- `apps/web/src/components/model-effort-slider.tsx`
- `apps/web/src/components/model-effort-slider.spec.tsx`

Do not update `packages/core/src/model-providers.ts` or server `models.static.ts` to pretend a provider/model is available when live discovery says otherwise. Update `AGENTS.md` only if a reusable convention changes.

## Edge cases

- Stored/localStorage Ultra after the catalog rolls back or the user switches Sol → Luna.
- Model default differs by account/CLI rollout; use the descriptor default, never a global `medium`.
- Zero/one effort choice: no unusable slider; retain valid default without showing a fake control.
- Unknown future effort strings remain renderable when advertised; unsupported strings are sanitized.
- Restart/reconnect: persisted `modelOptions` survives unchanged for the same model; no new durable state or WS event exists.

## Verification and ship gate

1. Install dependencies if absent; this planning worktree currently lacks Nest packages, so the baseline targeted run could only execute the pure Pi helper (5 passed; Nest-backed specs failed at import, not assertion).
2. `bun run --filter @nuncio/core test`
3. `bun run --filter @nuncio/web test`
4. From `apps/server`, run the Phase 1 targeted specs; then repo root `bun run test:daily-driver`.
5. Real Chrome against the non-watch server: open the live Codex picker, verify Sol/Terra Ultra and Luna Max-only, keyboard/drag behavior, and both themes. Do not start a model turn.
6. `bun run check-changeset`, `bun run gate`, then `bun run gate:full` before PR/promotion.
7. Run code review after green tests; fix blockers and record any non-blocking warning.

## Success criteria

- No stale Ultra reaches Luna or another model that does not advertise it.
- Web, mobile/shared API shapes remain provider-neutral and backward compatible.
- README explains runtime discovery, the three GPT-5.6 variants, and Ultra's automatic delegation behavior.
- User-facing patch changeset and all required gates pass.

## Open questions

None.
