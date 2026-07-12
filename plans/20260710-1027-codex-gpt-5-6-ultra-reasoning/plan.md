# Plan — Codex GPT-5.6 Ultra and Pi 0.80.6

**Started:** 2026-07-10 10:27 ACST
**Status:** Complete
**Branch:** `feat/codex-gpt-5-6-ultra`

## Goal

Expose only the reasoning choices each Codex or Pi model actually supports, then pass the selected choice through the existing provider-neutral `modelOptions` contract. Adopt Pi 0.80.6 and settle successful Pi auto-retries correctly without provider branches in sessions, core, or web.

## Grounded baseline

- `AgentRunContext.modelOptions`, session DTO/persistence, task inheritance, and `turn/start` forwarding already exist.
- Codex `model/list` already maps `supportedReasoningEfforts` into a per-model `reasoningEffort` descriptor; the generic picker renders any descriptor as a slider.
- Pi is the reference pattern: `piThinkingDescriptors()` derives choices from each model's `thinkingLevelMap`. Nuncio declares `^0.80.2` and locks `0.80.2`; upstream `0.80.6` adds `max`, not Codex-style `ultra`.
- Local Codex 0.144.1 currently advertises `gpt-5.6-sol`, `-terra`, and `-luna`; Sol/Terra include `ultra`, Luna ends at `max`.
- Generated app-server types say `turn/start.effort` is the override and deprecate `multiAgentMode` in favor of `effort: "ultra"`. Re-check this at implementation time because the protocol is experimental.

## Architecture decision

- Treat `ModelOptionDescriptor.options` from the runtime catalog as capability metadata. Do not add `supportsUltra`, widen `AgentCapabilities`, or inspect provider ids in UI/session code.
- Persist `{ reasoningEffort: "ultra" }` exactly like any other option. The Codex adapter alone translates it to current app-server wire fields.
- Keep live `model/list` authoritative. Do not add GPT-5.6 to the degraded fallback: Codex only advertises it from CLI `0.144.0`, and older or non-entitled runtimes must not receive unusable choices.
- Keep `codex-app-server.client.ts`, `agents.types.ts`, session DTOs/repository/service, and DB schema unchanged unless the fresh protocol probe proves a new wire contract is required.
- Keep Pi model metadata authoritative: `off` through `high` remain baseline levels unless mapped to `null`; `xhigh` and `max` appear only when the selected model explicitly maps them to non-null values.

## Phases

| Phase | Focus | Status | Plan |
|---|---|---|---|
| 1 | Protocol gate, Codex catalog/adapter tests, minimal mapping/fallback work | Complete | [phase-01-codex-catalog-and-adapter.md](./phase-01-codex-catalog-and-adapter.md) |
| 2 | Shared option sanitization, picker proof, docs/changeset/gates | Complete | [phase-02-shared-picker-and-shipping.md](./phase-02-shared-picker-and-shipping.md) |
| 3 | Pi 0.80.6, model-specific Max, retry settlement, docs/gates | Complete | [phase-03-pi-0-80-6-max-and-retry-settlement.md](./phase-03-pi-0-80-6-max-and-retry-settlement.md) |

## Non-goals

- Adding GPT-5.6 rows to the Codex static fallback.
- A provider-specific Ultra button, session column, event type, or FSM state.
- Running a paid Ultra turn in smoke tests; unit wire assertions plus live catalog discovery are sufficient.
- Refactoring the full 800+ line Codex provider beyond the touched model-option seam.
- Pi usage/cost observability, title sync, `stopReason: "length"` UX, or branch-aware transcript hydration.

## Risks and controls

| Risk | Control |
|---|---|
| Catalog differs by CLI/account rollout | Runtime metadata stays authoritative; static fallback does not claim GPT-5.6 support. |
| Stored Ultra survives after switching to Luna/older catalog | Generic descriptor-based sanitization resets unsupported select values to the model default. |
| App-server changes Ultra transport | Regenerate bindings and probe `model/list`/`collaborationMode/list`; change adapter only with evidence. |
| Ultra consumes more tokens and fans out work | Never use Ultra for browser/integration smoke; document behavior in UI/docs. |
| Pi metadata omits advanced levels | Never infer `xhigh`/`max`; expose them only from explicit non-null mappings. |
| Pi retry emits an error before eventual success | Clear the remembered turn error on a later successful assistant `message_end`; preserve terminal-error behavior. |

## Definition of done

When the runtime advertises them, Sol/Terra expose Ultra and Luna does not; selecting Ultra reaches Codex through the shared option path; stale unsupported options are removed generically. Pi resolves at 0.80.6, exposes Max only where explicitly supported, and treats a successful auto-retry as success. Targeted tests, `gate:full`, safe real-provider checks, review, docs, and the patch changeset are complete.

## Open questions

None. If the implementation-time generated schema contradicts `effort: "ultra"`, stop and resolve that protocol change before coding.
