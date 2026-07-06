# Phase 1 — Provider core

**Effort:** 1.5d
**Depends on:** Phase 0 findings (capabilities matrix final).

## Files

| File | Role |
|------|------|
| `apps/server/src/agents/providers/claude-agent.provider.ts` | `ClaudeAgentProvider extends BaseAgentProvider` — Query lifecycle, executePrompt, interrupt, setModel, dispose |
| `apps/server/src/agents/providers/claude-agent.helpers.ts` | Pure mapping: SDK message stream → nuncio event calls (unit-testable without SDK) |
| `apps/server/src/agents/providers/claude-cli-resolver.ts` | Availability probe: bundled binary → `auth status` JSON; `NUNCIO_CLAUDE_BIN` override; follows `codex-cli-resolver.ts` shape |
| `apps/server/src/agents/agents.module.ts` | Register `ClaudeAgentProvider` |
| `apps/server/src/agents/agents.registry.ts` | Add to `this.providers` (constructor, line ~34). Do NOT touch `defaultId()` priority |
| `apps/server/src/settings/settings.registry.ts` | Entries: `ANTHROPIC_API_KEY` (secret, providerId `claude`), `NUNCIO_CLAUDE_BIN` (path override) |
| `apps/server/test/unit/agents/claude-agent.contract.spec.ts` | Conformance: instantiate `provider-contract.suite.ts` harness with SDK stubbed at the adapter boundary |

Keep each file under ~200 lines — the mapping helpers absorb complexity so the provider stays a thin lifecycle shell (Pi/Codex precedent).

## Provider skeleton decisions

- `id = 'claude'`, `name = 'Claude'`; capabilities from the finalized matrix.
- **Session handle:** `Map<sessionId, { query: Query; pushInput(msg): void; abort: AbortController }>`. The input side is an async generator fed by a small queue so `executePrompt`/steer push messages without recreating the query.
- **executePrompt flow:**
  1. Existing handle → push message (steer path; mid-run per S2 finding).
  2. No handle → build options: `cwd: context.workspace ?? session.workspace`, `model` (strip `claude:` prefix), `resume: session.providerThreadId ?? undefined`, `includePartialMessages: true`, `permissionMode` (founder decision D2), `settingSources` (per S10), `env` (pass `ANTHROPIC_API_KEY` from settings when present — subscription keychain works with no env).
  3. Consume the message stream through `claude-agent.helpers.ts` mapping (table in plan.md), calling `this.pushEvent(...)`.
  4. On `system/init`: `sessions.updateProviderRuntimeState(sessionId, { providerThreadId: session_id })`.
  5. On `result` success: emit `assistant_message { text: result.result }`, return.
  6. On error subtypes / thrown SDK errors: throw — base class lands ERROR.
- **interrupt():** `handle.query.interrupt()`; emit follows base/session-layer conventions (match Codex behavior for the `interrupted` event source).
- **setModel():** `handle.query.setModel(stripped)` when live; otherwise store for next query construction.
- **canResumeThread(session):** `providerThreadId` non-empty (same as `pi-agent.provider.ts:132`).
- **dispose():** per S9 finding — interrupt/close, verify no orphan `claude` subprocess, idempotent.
- **isAvailable():** resolver probe (`auth status` JSON `loggedIn === true`) OR `ANTHROPIC_API_KEY` resolved from settings. Cache; `bustCache()` clears (settings changes already bust caches).
- **listModels():** from `initializationResult().models` when a probe query is cheap enough, else a static catalog for v1 with the init-result path as fast-follow. Format: single group, `id: 'claude'`, models like `claude:claude-fable-5`. Decide in-phase based on init cost measured in S1.

## Conformance spec notes

`provider-contract.suite.ts` needs: `arrangeSuccess(deltas, finalText)`, `arrangeError()`, capability-honesty hooks. Stub the SDK at the module boundary (inject a fake `query` factory into the provider — constructor-injected factory like Codex's client, not a module mock), so the spec drives: run happy-path, delta coalescing, authoritative final text, mid-turn error → ERROR, dispose idempotency, steer-after-dispose revival, declared capabilities honesty (interrupt true must work; declared-off rejects 409).

## Exit criteria

- `bun run build && bun run lint` clean.
- `bun test` green including `claude-agent.contract.spec.ts`.
- Manual smoke: create session with `claude:…` model in dev web UI → streams, steers, interrupts, resumes after daemon restart.
