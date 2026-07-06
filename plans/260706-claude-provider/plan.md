# Plan — Claude provider (Claude Agent SDK primary, Claude Code CLI support)

**Started:** 2026-07-06
**Status:** In progress (founder go 2026-07-06; Fable orchestrates, Opus implements)
**Branch:** worktree `practical-matsumoto-e30a89`

## Goal

Add a first-class `claude` provider to nuncio so a session can run **Claude Code** (Fable/Opus/Sonnet/Haiku) with full streaming, steer, interrupt, resume-across-restart, images, and nuncio-native permission approvals — implemented against the locked provider contract (ADR-004), zero per-provider branches in sessions/UI.

## Why now / freeze note

The 2026-07-02 scaling direction froze new providers (Pi stability + dogfood). Oscar explicitly re-opened this for Claude on 2026-07-06 after a research pass. This plan is the artifact of that research; **shipping still needs an explicit founder go** — see Open decisions.

## Core decisions (locked by Oscar, 2026-07-06)

- **Primary surface: `@anthropic-ai/claude-agent-sdk`** (TypeScript, in-process, same pattern as Pi/Cursor SDK providers). One `query()` in **streaming input mode** per active session; the SDK spawns and manages a bundled Claude Code CLI subprocess.
- **Support surface: Claude Code CLI** — used for the availability/auth probe (`claude auth status` → JSON) and as an escape hatch (`claude -p --output-format stream-json --resume <id>` shares the same on-disk session store, so headless/CI reuse stays possible). **No CLI-based provider variant in v1.**
- **No reverse-engineered app-server.** Anthropic publishes no control-protocol/app-server for Claude Code; third-party JSON-RPC wrappers are unsupported. SDK + CLI only.
- **Auth: subscription-ride for local dogfood, API key for distribution.** The SDK-spawned CLI reads the shared keychain/`~/.claude` credentials, so Oscar's Max login rides automatically (CLI-first, disable-not-prompt — no OAuth flow in nuncio). `ANTHROPIC_API_KEY` settings entry exists from day 1 for the distribution path (ToS: third-party apps must not offer claude.ai subscription login to end-users).

## Verified facts (SDK 0.3.201 typings via `npm pack`, local CLI 2.1.201, 2026-07-06)

| Fact | Evidence |
|------|----------|
| `Options.canUseTool` exists; receives `toolName`, `input`, plus `suggestions` (permission updates for "always allow"), `title` (rendered prompt sentence), `displayName`, `blockedPath`, `decisionReason` | `sdk.d.ts:206`, `sdk.d.ts:1336` |
| `Query` (streaming input mode): `interrupt()`, `setModel()`, `setPermissionMode()`, `setMcpServers()` (supports **in-process SDK servers**), `streamInput()`, `initializationResult()` | `sdk.d.ts:2236–2489` |
| `initializationResult()` → `{ models: ModelInfo[], … account info }` | `sdk.d.ts:3313–3318` |
| Token/thinking deltas: `includePartialMessages: true` → `stream_event` (`SDKPartialAssistantMessage`) wrapping raw API stream events | `sdk.d.ts:1585`, `sdk.d.ts:3884` |
| Images: `SDKUserMessage.message: MessageParam` (from `@anthropic-ai/sdk/resources`) → content accepts base64 image blocks | `sdk.d.ts:8`, `sdk.d.ts:4292–4294` |
| Resume: `resume: <sessionId>`, `forkSession`, `resumeSessionAt` (resume from mid-conversation); sessions persist as JSONL under `~/.claude/projects/<encoded-cwd>/`, cwd-scoped, survive daemon restart | `sdk.d.ts:1757–1771` |
| Mid-run input: `SDKUserMessage.priority?: 'now' \| 'next' \| 'later'` and `shouldQuery?: boolean` — mechanism for steer-while-running exists; exact mid-turn semantics unverified | `sdk.d.ts:4298–4305` |
| Auth probe: `claude auth status` → JSON `{loggedIn, authMethod, subscriptionType, email, orgId}`; verified live on this Mac (`loggedIn: true`, `max`) | CLI 2.1.201 |
| SDK bundles per-platform CLI binaries (`optionalDependencies`); `pathToClaudeCodeExecutable` overrides; the bundled binary itself can run `auth status`, so a system `claude` install is **not required** | npm metadata; `sdk.d.ts:1684–1686` |
| `env` option passes environment to the CLI subprocess | `sdk.d.ts:1407` |

## Capabilities matrix (finalized by Phase 0 spike — `spike-findings.md`, 2026-07-06)

| Capability | Value | Basis |
|-----------|-------|-------|
| `interrupt` | `true` | `query.interrupt()` — live: `result.terminal_reason:'aborted_tools'`, process survived, follow-up worked (S3) |
| `modelSwitch` | `'in-session'` | `query.setModel()`; catalog from `initializationResult().models` (S1) |
| `effortSwitch` | `'in-session'` | `Options.effort` + `query.applyFlagSettings({ effortLevel })` mid-session, no throw — live (S6). Model-gated: Haiku has no effort |
| `images` | `true` | live: base64 PNG image block → model answered "Red." for a 2×2 red PNG (S5) |
| `steerWhileRunning` | `true` | `priority:'now'` truncated the in-flight turn (2/5 tool calls) and redirected — live (S2); redirect surfaces as a new assistant turn |

## Event mapping (SDK → nuncio shared contract)

| SDK message | nuncio event |
|-------------|--------------|
| `system/init` (`session_id`) | store as `providerThreadId` via `sessions.updateProviderRuntimeState` (pattern: `codex-agent.provider.ts:349`) |
| `stream_event` → `text_delta` | `assistant_delta { delta }` |
| `stream_event` → `thinking_delta` | `thinking_start` / `thinking_delta { thinkingId }` (thinkingId = message id + block index) |
| `assistant` message `tool_use` block | `tool_start { callId: tool_use.id, tool: name, input }` |
| tool result (user message with `tool_use_result` / `tool_result` block) | `tool_end { callId: tool_use_id, isError, output }` |
| `result` (`subtype: 'success'`) | `assistant_message { text: result.result }` — authoritative terminal text (conformance requires match) |
| `result` (error subtypes) | **discriminate first** (spike S3/S4): `error_during_execution` + `terminal_reason:'aborted_tools'` = interrupt (→ `interrupted`, not ERROR); `errors[]` "No conversation found…" = cannot-resume (clean user-facing error); steer-`'now'` early-terminal = redirect, session stays alive. Only genuinely unexplained subtypes throw → ERROR |
| `system/api_retry`, rate-limit events | log only (no user-facing event) in v1 |
| Task/subagent messages (`SDKTaskNotification…`) | ignore in v1 (see Non-goals) |

Codex lesson applies (glued-text): deltas per assistant message id — insert separation when the message id changes before emitting.

## Architecture sketch

```
apps/server/src/agents/providers/
├── claude-agent.provider.ts      # extends BaseAgentProvider; owns Query lifecycle
├── claude-agent.helpers.ts       # SDK message → nuncio event mapping (pure functions)
└── claude-cli-resolver.ts        # auth/availability probe via `auth status` (bundled binary first, NUNCIO_CLAUDE_BIN override)
```

- One active `Query` per running session, held in a `Map<sessionId, handle>`; `dispose()` interrupts + closes (kills the CLI subprocess).
- `executePrompt` first turn: `query({ prompt: asyncIterable, options: { cwd: workspace, resume?, model, includePartialMessages: true, canUseTool, settingSources, permissionMode, env } })`; subsequent steers push into the same iterable (or `streamInput`).
- Resume after daemon restart: new `query()` with `resume: providerThreadId` + same `cwd` → `canResumeThread` returns true when `providerThreadId` set (pattern: `pi-agent.provider.ts:132`).
- `context.tools` (AgentRuntimeTools) → in-process SDK MCP server via `createSdkMcpServer`/`setMcpServers` — no subprocess, direct `execute` callbacks.
- Registration: add to `agents.module.ts` providers array and `agents.registry.ts` constructor (`this.providers = [pi, cursor, codex, claude]`); **do not** change `defaultId()` priority in v1.

## Phases

| Phase | Focus | Effort | Plan |
|-------|-------|--------|------|
| 0 | Spike — streaming, steer `'now'`, images, resume, effort, auth ride | 0.5–1d | [phase-00-spike-sdk-validation.md](./phase-00-spike-sdk-validation.md) |
| 1 | Provider core — SDK wiring, event mapping, resolver, settings, registration, conformance spec | 1.5d | [phase-01-provider-core.md](./phase-01-provider-core.md) |
| 2 | Permissions + runtime tools — `canUseTool` → nuncio approvals; in-process MCP for `context.tools` | 1d | [phase-02-permissions-runtime-tools.md](./phase-02-permissions-runtime-tools.md) |
| 3 | Images, model/effort options, picker polish | 0.5d | [phase-03-images-models-polish.md](./phase-03-images-models-polish.md) |
| 4 | Hardening — opt-in integration test, docs, changeset, ship | 1d | [phase-04-hardening-ship.md](./phase-04-hardening-ship.md) |

**Total:** ~4.5–5d sequential. Phase 0 gates everything (capabilities matrix). Phases 2 and 3 are independent after 1; can parallelize.

```
P0 ──► P1 ──► P2 ──► P4
          └─► P3 ──^
```

## Risks

| Risk | Mitigation |
|------|------------|
| SDK 0.3.x churn / CLI version coupling | Pin exact SDK version; bundled binary pinned at SDK release. Bump deliberately, re-run conformance + integration. |
| Session JSONL format is internal | Never parse JSONL; store only `session_id`, resume through the SDK. |
| Resume is cwd-scoped | Always pass `cwd: session.workspace` explicitly; workspace is immutable on the session row already. If workspace dir is deleted, surface a clean "cannot resume" error. |
| `canUseTool` parks forever if unanswered (fail-closed, no deadline) | Route through the existing interaction/approval flow which already has pending-state UX; `dispose()` aborts via signal. |
| One CLI subprocess per active session (memory) | Same cost class as Codex app-server; dispose aggressively on IDLE-timeout if it becomes a problem (not v1). |
| ToS on subscription auth if nuncio distributes | API-key settings path shipped in v1; subscription ride stays a local-dogfood convenience, never a login flow nuncio offers. |
| `settingSources` pulling Oscar's `~/.claude` (plugins, hooks) into nuncio sessions unexpectedly | v1 default: no user/project setting sources (clean, reproducible). Founder can flip later. |

## Non-goals (v1)

- CLI-headless provider variant (only if the SDK path hits a wall).
- Rendering Claude Code subagents/Tasks/background agents as nuncio structure (events ignored, not lost — transcript still coherent).
- Passing through Oscar's `~/.claude` plugins/skills/hooks into nuncio-run sessions.
- Handoff/import of existing terminal Claude Code sessions into nuncio (the Cursor-handoff analog) — natural fast-follow, listed below.
- Subscription login UI for third-party users (ToS).
- Changing `defaultId()` provider priority.

## Founder decisions (resolved 2026-07-06)

1. **Timing — GO.** Oscar approved building now ("cook cái plan đó"), in this worktree; provider freeze lifted for Claude specifically.
2. **Default permission mode: `acceptEdits`** + `canUseTool` for everything else (Bash etc.) — recommended option accepted; exposed as a setting so it stays changeable without code.
3. **`settingSources` v1 default: empty** — session behavior fully determined by nuncio; `user` passthrough remains a documented toggle for later.

## Fast-follows (not this plan)

- **"Always allow" button on the approval card** — the provider already implements the `updatedPermissions` round-trip (reachable via `submitInteraction` with an `always` option id); the binary approve/deny card needs the third affordance. UI-only change, `ProviderRequestDecision` widening touches ~15 files so it was deliberately deferred out of Phase 2.

- **Handoff: continue a terminal Claude Code session in nuncio** — same shape as the Cursor handoff plan; `~/.claude/projects/<encoded-cwd>/*.jsonl` + `resume` makes this cheap once the provider exists.
- Effort switching UI parity with Codex once spike confirms the SDK path.
- Cost surfacing (`result.total_cost_usd`, `usage`) into session metadata.
- `forkSession` → "branch this session" UX in the workbench.
