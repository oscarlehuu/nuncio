# Phase 2 — Permissions + runtime tools

**Effort:** 1d
**Depends on:** Phase 1 (provider running end-to-end).

## A. `canUseTool` → nuncio approvals

Wire the SDK's permission callback into nuncio's existing interaction plumbing instead of building anything new:

- Provider passes a `canUseTool` closure per session. On invocation:
  1. Build a `ProviderRequestInput` from the callback's `title` (preferred prompt text per typings), `displayName`, `toolName`, `input`, `decisionReason`, `blockedPath`.
  2. Call `context.requestProviderApproval(request)` → session layer emits `user_input_requested`, UI renders the pending approval (existing flow — see interactive-tools plan 260629).
  3. Map the user's answer to `PermissionResult`: allow / deny; when the user picks "always allow", return the callback's `suggestions` as `updatedPermissions` (typings document exactly this round-trip).
- **Fail-closed semantics:** typings warn an unanswered callback parks the tool forever. Tie the callback to the session's AbortSignal (dispose/interrupt rejects → deny) so a killed session never leaks a parked prompt.
- **Permission mode default (founder decision D2, recommended):** `acceptEdits` — file edits auto-approved, Bash/web/etc. route through `canUseTool`. Store as a provider-level setting so it's changeable without code (`settings.registry.ts` enum entry, e.g. `NUNCIO_CLAUDE_PERMISSION_MODE`).
- `supportsInteraction()` returns true; `submitInteraction()` resolves the pending callback promise by `requestId` (dedupe idempotently — `reinitialize()` may redeliver, per typings).

## B. `context.tools` → in-process SDK MCP server

Nuncio's `AgentRuntimeTools` (name, description, inputSchema, execute) map onto the SDK's in-process MCP server support (`setMcpServers` accepts SDK servers handled in the SDK process — no subprocess):

- New adapter `apps/server/src/agents/tools/claude-runtime-tools.adapter.ts` (mirror `cursor-runtime-tools.adapter.ts`): wrap each `AgentRuntimeTool` as an SDK MCP tool; `systemPromptAppend` → `appendSystemPrompt` option.
- Register at query construction (`mcpServers` option) rather than post-hoc `setMcpServers`, so resume + first turn see identical toolsets.
- Tool invocations surface as normal `tool_use`/tool-result messages → already covered by the Phase 1 event mapping (`tool_start`/`tool_end`); verify the MCP tool name prefix (`mcp__<server>__<tool>`) renders acceptably in the transcript, normalize in the mapping helper if noisy.

## Tests

- Unit: canUseTool mapping (allow/deny/always-allow suggestions, abort → deny) with a fake callback harness — no SDK.
- Unit: runtime-tools adapter schema pass-through + execute round-trip.
- Extend the contract spec's interaction scenario if the shared suite covers `user_input_requested` (check `provider-contract.suite.ts` capability hooks; Pi is the precedent).

## Exit criteria

- Bash command in a Claude session shows a nuncio approval card; approve runs it, deny returns a clean tool error; "always allow" isn't re-asked in-session.
- A session with injected runtime tools (e.g. mission-control verify tool) calls them successfully in-process.
