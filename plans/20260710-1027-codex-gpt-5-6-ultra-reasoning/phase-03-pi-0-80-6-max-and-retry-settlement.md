# Phase 3 — Pi 0.80.6 Max and retry settlement

## Context links

- [Overview](./plan.md)
- `apps/server/package.json`
- `bun.lock`
- `apps/server/src/agents/providers/pi-thinking.helpers.ts`
- `apps/server/src/agents/providers/pi-agent.provider.ts`

## Overview

**Priority:** High
**Status:** Complete
**Depends on:** Phases 1–2
**Purpose:** Adopt Pi 0.80.6, expose model-supported Max reasoning, and prevent a recovered auto-retry from leaving the Nuncio session in `ERROR`.

## Architecture and constraints

- Pi remains an in-process SDK provider behind the shared `AgentProvider` and `modelOptions` contracts.
- Keep Pi's wire value `max`; do not rename or translate it to Codex `ultra`, which means proactive multi-agent delegation.
- Treat `thinkingLevelMap` as model capability metadata. `off`, `minimal`, `low`, `medium`, and `high` are supported unless explicitly mapped to `null`; `xhigh` and `max` require an explicit non-null mapping.
- Clear a remembered Pi turn error only when a later assistant `message_end` is non-error; aborted or terminal error paths retain their existing semantics.
- Do not add new DTOs, persistence fields, events, capability flags, or provider checks outside the Pi adapter/helper.

## TDD implementation

1. **RED — Max/capabilities:** extend `apps/server/test/unit/agents/pi-thinking.helpers.spec.ts` to prove:
   - `max` is accepted, labeled `Max`, persisted, and resolved when explicitly mapped;
   - an omitted `xhigh` or `max` is not exposed;
   - baseline levels remain supported when omitted, but any explicit `null` level is removed;
   - an unsupported saved selection falls back to the advertised default.
2. **GREEN:** extend `PiThinkingLevel`, labels, validation, and supported-level derivation in `pi-thinking.helpers.ts` with the minimum capability-rule change.
3. **RED — retry settlement:** add a provider regression in `apps/server/test/unit/agents/pi-agent.provider.spec.ts` that emits an assistant error `message_end`, then a successful assistant `message_end` during the same prompt/auto-retry lifecycle. Assert the final run succeeds, emits the successful assistant text, and does not surface the stale first error.
4. **GREEN:** clear `lastTurnError` on the later successful assistant completion before final settlement. Keep the existing terminal-error regression green.
5. **Dependency:** change the declared minimum to `^0.80.6`, run `bun install`, and verify `bun.lock` resolves the Pi coding-agent/core/AI packages at `0.80.6`. Do not hand-edit the lockfile.
6. **Docs/release:** update `README.md` and `docs/system-architecture.md` with Pi 0.80.6, model-specific Max behavior, and the distinction from Codex Ultra. Amend the existing patch changeset so it describes both provider updates from the user's perspective.

## Files

**Required:**

- `apps/server/package.json`
- `bun.lock`
- `apps/server/src/agents/providers/pi-thinking.helpers.ts`
- `apps/server/test/unit/agents/pi-thinking.helpers.spec.ts`
- `apps/server/src/agents/providers/pi-agent.provider.ts`
- `apps/server/test/unit/agents/pi-agent.provider.spec.ts`
- `README.md`
- `docs/system-architecture.md`
- `.changeset/improved-codex-gpt-5-6-controls-by-labeling-ultr.md`

Touch other Pi tests only when the dependency or shared helper behavior requires their expectations to change. Do not update static model fallbacks to claim GPT-5.6 availability.

## Verification and ship gate

1. Capture the helper and retry regressions failing for assertion reasons before implementation.
2. From `apps/server`: `bun test test/unit/agents/pi-thinking.helpers.spec.ts test/unit/agents/pi-agent.provider.spec.ts test/unit/agents/pi-agent.listmodels.spec.ts test/unit/agents/pi-agent.contract.spec.ts`.
3. Run `bun run check-changeset` and root `bun run gate:full`.
4. If the existing Pi agent directory contains `auth.json`, run `bun test test/integration/pi-agent.integration.spec.ts` from `apps/server`; otherwise record the omission without reading credentials.
5. Run code review after all reachable tests are green; fix blockers before commit/PR.

## Success criteria

- The declared and locked Pi SDK version is 0.80.6-compatible.
- `max` round-trips only for models that explicitly advertise it; `xhigh` follows the same advanced-level rule.
- A failed attempt followed by a successful Pi auto-retry settles successfully without a stale error event or `ERROR` session status.
- Docs and the patch changeset accurately distinguish Pi Max from Codex Ultra; all reachable gates are green.

## Non-goals

- Usage/reasoning/cost observability.
- Pi title synchronization through `session_info_changed`.
- `stopReason: "length"` user experience.
- Branch-aware or compacted transcript hydration.

## Open questions

None.
