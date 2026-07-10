# Phase 1 — Codex catalog and adapter

## Context links

- [Overview](./plan.md)
- `apps/server/src/agents/providers/codex-agent.provider.ts`
- `apps/server/src/agents/providers/codex-app-server.client.ts`
- `apps/server/src/agents/providers/pi-thinking.helpers.ts`
- [Official models](https://developers.openai.com/codex/models/)
- [Official app-server guide](https://developers.openai.com/codex/app-server/)

## Overview

**Priority:** High
**Status:** Complete
**Purpose:** Pin the current protocol, add the missing GPT-5.6/model-specific regressions, then make only changes those tests require.

## Key insights

- Current runtime discovery already carries arbitrary effort strings and current Codex forwarding already sends `effort`; GPT-5.6 is not a new session contract.
- The runtime response is per-model. Sol/Terra advertise `low, medium, high, xhigh, max, ultra`; Luna advertises the same list without Ultra.
- Pi proves the intended architecture: provider adapter converts provider model metadata into shared option descriptors; downstream code remains generic.

## Protocol gate — before RED

1. Record `codex --version` and `codex login status` without exposing credentials.
2. Run `codex app-server generate-ts --experimental --out <tmp>`; inspect `v2/Model.ts`, `v2/TurnStartParams.ts`, and `v2/CollaborationMode*.ts`.
3. Probe `model/list` and `collaborationMode/list` through `CodexAppServerClient`; record ids, supported efforts, defaults, and descriptions.
4. Current expected mapping is `turn/start { effort: "ultra" }`. If a newer target explicitly requires a collaboration preset, revise this phase first; do not send both fields speculatively.

## TDD implementation

1. **RED:** extend `apps/server/test/unit/agents/codex-agent.provider.spec.ts` with a three-model fixture and assert:
   - all GPT-5.6 ids/names survive unchanged;
   - Sol/Terra include Ultra, Luna does not;
   - each model keeps its advertised default and order;
   - human labels include `Extra High`, `Max`, and `Ultra · Multi-agent`.
2. Add a characterization assertion in the same spec that selecting `codex:gpt-5.6-sol` + `{ reasoningEffort: "ultra" }` emits `turn/start` with `model: "gpt-5.6-sol"` and `effort: "ultra"`. It may already pass; do not manufacture a source change.
3. **GREEN:** update only the model parsing/label helpers inside `codex-agent.provider.ts`. Preserve runtime option order/defaults; filter hidden models; never infer Ultra from a model name.
4. Keep the existing degraded fallback free of GPT-5.6 rows. CLI versions before `0.144.0` and accounts without entitlement must not see unusable Sol/Terra/Luna choices.
5. **REFACTOR:** keep model mapping pure and focused. Extract a small `codex-model-options.helpers.ts` only if the touched provider section cannot stay readable; do not reorganize unrelated lifecycle code.

## Files

**Required:**

- `apps/server/test/unit/agents/codex-agent.provider.spec.ts`
- `apps/server/src/agents/providers/codex-agent.provider.ts`

**Conditional on protocol evidence:**

- `apps/server/src/agents/providers/codex-app-server.client.ts` and its spec, only if a newly typed/probed RPC is necessary.
- `apps/server/test/integration/codex-agent.integration.spec.ts`, only for catalog assertions that self-skip when GPT-5.6 is unavailable; never execute Ultra.

**Explicitly unchanged:** `agents.types.ts`, `models.types.ts`, `models.service.ts`, session DTOs/persistence/service, `pi-agent.provider.ts`, `pi-thinking.helpers.ts`, and database schema.

## Verification

- From `apps/server`: `bun test test/unit/agents/codex-agent.provider.spec.ts test/unit/agents/pi-thinking.helpers.spec.ts`
- Opt-in, login present: `bun run test:integration:codex` (discovery/cheap low-effort turn only).
- Failure paths: hidden model omitted; duplicate efforts deduped; empty/legacy effort arrays stay usable; app-server error lands session `ERROR`, never stuck `RUNNING`.

## Success criteria

- Catalog metadata—not provider/model name checks or static fallback rows—decides where Ultra appears.
- Current wire mapping is proven by schema plus a unit request assertion.
- Pi behavior and all locked ADRs remain unchanged.

## Open questions

None unless the protocol gate changes Ultra's wire representation.
