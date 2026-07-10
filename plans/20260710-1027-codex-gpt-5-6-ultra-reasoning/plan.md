# Plan — Codex GPT-5.6 and model-specific Ultra reasoning

**Started:** 2026-07-10 10:27 ACST
**Status:** Complete
**Branch:** `feat/codex-gpt-5-6-ultra`

## Goal

Expose GPT-5.6 models and only the reasoning choices each model actually supports, then pass the selected choice through the existing provider-neutral `modelOptions` contract. No Codex/Pi branch in sessions, core, or web.

## Grounded baseline

- `AgentRunContext.modelOptions`, session DTO/persistence, task inheritance, and `turn/start` forwarding already exist.
- Codex `model/list` already maps `supportedReasoningEfforts` into a per-model `reasoningEffort` descriptor; the generic picker renders any descriptor as a slider.
- Pi is the reference pattern: `piThinkingDescriptors()` derives choices from each model's `thinkingLevelMap`. Nuncio remains pinned to the `0.80.2` lock in this change; upstream `0.80.6` adds `max`, not Codex-style `ultra`, and is reported separately.
- Local Codex 0.144.1 currently advertises `gpt-5.6-sol`, `-terra`, and `-luna`; Sol/Terra include `ultra`, Luna ends at `max`.
- Generated app-server types say `turn/start.effort` is the override and deprecate `multiAgentMode` in favor of `effort: "ultra"`. Re-check this at implementation time because the protocol is experimental.

## Architecture decision

- Treat `ModelOptionDescriptor.options` from the runtime catalog as capability metadata. Do not add `supportsUltra`, widen `AgentCapabilities`, or inspect provider ids in UI/session code.
- Persist `{ reasoningEffort: "ultra" }` exactly like any other option. The Codex adapter alone translates it to current app-server wire fields.
- Keep live `model/list` authoritative. Do not add GPT-5.6 to the degraded fallback: Codex only advertises it from CLI `0.144.0`, and older or non-entitled runtimes must not receive unusable choices.
- Keep `codex-app-server.client.ts`, `agents.types.ts`, session DTOs/repository/service, and DB schema unchanged unless the fresh protocol probe proves a new wire contract is required.

## Phases

| Phase | Focus | Status | Plan |
|---|---|---|---|
| 1 | Protocol gate, Codex catalog/adapter tests, minimal mapping/fallback work | Complete | [phase-01-codex-catalog-and-adapter.md](./phase-01-codex-catalog-and-adapter.md) |
| 2 | Shared option sanitization, picker proof, docs/changeset/gates | Complete | [phase-02-shared-picker-and-shipping.md](./phase-02-shared-picker-and-shipping.md) |

## Non-goals

- Updating Pi's SDK, thinking levels, or retry lifecycle; those upstream `0.80.6` opportunities are reported separately.
- Adding GPT-5.6 rows to the Codex static fallback.
- A provider-specific Ultra button, session column, event type, or FSM state.
- Running a paid Ultra turn in smoke tests; unit wire assertions plus live catalog discovery are sufficient.
- Refactoring the full 800+ line Codex provider beyond the touched model-option seam.

## Risks and controls

| Risk | Control |
|---|---|
| Catalog differs by CLI/account rollout | Runtime metadata stays authoritative; static fallback does not claim GPT-5.6 support. |
| Stored Ultra survives after switching to Luna/older catalog | Generic descriptor-based sanitization resets unsupported select values to the model default. |
| App-server changes Ultra transport | Regenerate bindings and probe `model/list`/`collaborationMode/list`; change adapter only with evidence. |
| Ultra consumes more tokens and fans out work | Never use Ultra for browser/integration smoke; document behavior in UI/docs. |

## Definition of done

When the runtime advertises them, Sol/Terra expose Ultra and Luna does not; selecting Ultra persists and reaches Codex through the shared option path; stale unsupported options are removed generically; targeted tests, `gate`, `gate:full`, real picker verification, code review, docs, and a patch changeset are complete.

## Open questions

None. If the implementation-time generated schema contradicts `effort: "ultra"`, stop and resolve that protocol change before coding.
