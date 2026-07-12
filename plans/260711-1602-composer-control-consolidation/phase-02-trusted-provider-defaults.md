# Phase 2 — Trusted provider defaults

**Priority:** P0 · **Status:** Pending

## Context

- UI plumbing: [`apps/web/src/App.tsx`](../../apps/web/src/App.tsx),
  [`home-surface.tsx`](../../apps/web/src/components/home-surface.tsx),
  [`grid-view.tsx`](../../apps/web/src/components/grid-view.tsx),
  [`session-detail.tsx`](../../apps/web/src/components/session-detail.tsx)
- Claude runtime: [`claude-agent.provider.ts`](../../apps/server/src/agents/providers/claude-agent.provider.ts)
- Advanced settings: [`settings.registry.ts`](../../apps/server/src/settings/settings.registry.ts)

## Requirements and architecture

- Remove the approval-mode selector from new-session and steer composers for every engine. Delete
  `approval-mode-picker.tsx` and `codex-approval-engine.ts` after proving no callers remain.
- Remove `ApprovalMode`, `approvalMode`, `onApprovalModeChange`, setting-derived state, and update
  callbacks from App → Home/Grid/Session prop chains. Do not alter session-create API shape.
- Preserve provider-request transcript cards and `respondProviderRequest`; these are required when an
  advanced Settings override intentionally chooses Codex `approval-required` or a prompting Claude mode.
- Codex runtime behavior remains `full-access` / `approvalPolicy: never` by default.
- Change both Claude sources of truth—the provider fallback constant and setting registry default—to
  `bypassPermissions`. Unknown/stale values also fall back to bypass. Explicit stored/env overrides win.

## TDD and files

1. RED: replace approval-picker expectations in `home-view.spec.tsx`, `session-detail.spec.tsx`,
   `grid-view.spec.tsx`, and relevant `App.spec.tsx` wiring with absence assertions while retaining
   provider-request response tests.
2. RED: update `apps/server/test/unit/agents/claude-agent.provider.spec.ts` for unset and invalid values
   → `bypassPermissions`, plus explicit `plan`/`acceptEdits` override coverage.
3. RED: update settings registry tests (or add a focused assertion) for the advertised default and
   option list; keep Codex's `full-access` default assertion unchanged.
4. GREEN: remove UI components/plumbing and update Claude fallback/registry copy.
5. Sync [`README.md`](../../README.md) and any matching `.env.example` copy: local defaults bypass
   prompts, while Settings remains the advanced override surface.

## Success criteria / security

- No permission mode appears in Home, Grid maximize, or Session composers; no dead approval-mode code.
- Default Codex and Claude runs do not prompt. Explicit restrictive modes still fail closed and can be
  answered through the existing durable provider-request path.
- This broadens Claude's default authority. Document “trusted local workspace” clearly; do not weaken
  Crew runtime policy, deterministic verification sandboxing, or provider-request persistence.

