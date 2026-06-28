# Phase 03 — Cursor CLI Provider

**Priority:** P1 (core — this is what makes handoff "not lose context")
**Status:** Not started
**Depends on:** Phase 2 (schema + handoff row exists)
**Estimated:** 1.5 days
**Lane:** A (backend)

## Context Links

- [Plan overview](./plan.md)
- [Phase 0 findings](./spike-findings.md) — canonical spawn command + stream-json schema
- Existing provider: `apps/server/src/agents/providers/cursor-agent.provider.ts` (SDK pattern to mirror)
- Base class: `apps/server/src/agents/agents.base-provider.ts`
- Contract: `apps/server/src/agents/agents.types.ts` (`AgentProvider`, `AgentRunContext`, `EventEmitter`)

## Overview

A second `AgentProvider` that runs the `cursor` CLI as a subprocess, resumes the imported chat by `chatId`, and streams tokens back through the same event contract as the SDK provider. Nuncio's session layer and frontend don't branch on provider — they see `assistant_delta` / `tool_start` / `tool_end` / `assistant_message` like always.

## Key insights

- One subprocess per steer. Cold start ~5–15s before first token (acceptable for handoff; not for fresh sessions, which is why SDK stays).
- `agent -p --trust --force --resume <chatId> --workspace <cwd> --output-format stream-json --stream-partial-output "<msg>"` is the canonical command (locked in Phase 0).
- stream-json emits one JSON object per stdout line. Token deltas = `type: assistant` + `timestamp_ms` present + `model_call_id` absent (per Cursor docs). Final = `type: result` with `subtype: success|error`.
- `--trust --force` skips approval — sandbox story must be solid (see Security).
- The CLI process owns the agent loop for this session; Nuncio only forwards events. No in-process handle to dispose — killing the subprocess = cancel.
- `agent ls` is TUI-only → we never call it. List comes from Phase 1's filesystem scan.

## Requirements

### Functional
- `CursorCliProvider implements AgentProvider` with `id = 'cursor-cli'` (registered alongside `cursor` SDK provider, but **not** in `AgentRegistry.available()` for new-session creation — only used when a session's `cursor_backend === 'cli'`).
- `executePrompt()` spawns the CLI, parses stdout NDJSON, emits events via `BaseAgentProvider.pushEvent()`.
- Map stream-json → Nuncio events:
  - `assistant` + `timestamp_ms` + no `model_call_id` → `assistant_delta { delta }`
  - `assistant` without `timestamp_ms` (final flush) → skip (delta already covered) OR coalesce
  - `tool-call-started`/`tool-call-completed` (if present in stream-json) → `tool_start` / `tool_end`
  - `result` + `subtype: success` → `assistant_message { text: result.result }` + IDLE
  - `result` + `subtype: error` → `error` event + FSM ERROR
  - `error` type → `error` event
- `steer()` re-spawns the CLI with the same `--resume <chatId>` (the CLI checkpoint is the conversation state; Nuncio holds no in-process handle between steers).
- `dispose(sessionId)` kills any running subprocess for that session.
- `isAvailable()` checks `agent` binary exists on PATH (or `NUNCIO_CURSOR_AGENT_BIN` setting) — no network call.
- `listModels()` returns `[]` (CLI uses the account's default; model selection for handoff sessions is out of scope for v1).

### Non-functional
- Subprocess must be killed on session archive/dispose (no orphans).
- stderr captured → emitted as `error` event if non-empty, else logged.
- Timeout: configurable, default 10 min for a single steer (handoff tasks can be long).
- Must not block the event loop — spawn is async, parsing is line-by-line.
- Bun compat: `node:child_process` `spawn` works under Bun (verified — no better-sqlite3 issue here).

## Architecture

### Routing

`SessionsService.steer()` (and `run()` if ever called on a handoff session — it shouldn't be) resolves the provider:

```
const backend = session.cursor_backend ?? 'sdk';
const provider = backend === 'cli'
  ? agents.get('cursor-cli')
  : agents.get(session.provider);
```

`AgentRegistry` exposes `get(id)` (already does). `CursorCliProvider` is registered in `AgentsModule` but **not** returned by `available()` (so it's not in the model picker / new-session provider list).

### Provider shape

```
CursorCliProvider extends BaseAgentProvider
  - activeProcesses: Map<sessionId, ChildProcess>
  - executePrompt(context): spawn CLI, pipe stdout → line parser → pushEvent
  - steer(): same as executePrompt (BaseAgentProvider handles RUNNING transition)
  - dispose(sessionId): kill + remove from map
  - isAvailable(): agent binary check
  - listModels(): Promise<ModelProviderDto[]> → []
```

### Stream parser (pure, unit-tested)

`cursor-cli-stream.parser.ts` — pure function `parseLine(line: string): NuncioEvent | null`. Same TDD approach as Phase 1's transcript parser.

## Related code files

**Create:**
- `apps/server/src/agents/providers/cursor-cli.provider.ts`
- `apps/server/src/agents/providers/cursor-cli-stream.parser.ts`
- `apps/server/src/agents/providers/cursor-cli.helpers.ts` (binary resolution, arg building)
- `apps/server/test/unit/agents/cursor-cli.provider.spec.ts`
- `apps/server/test/unit/agents/cursor-cli-stream.parser.spec.ts`

**Modify:**
- `apps/server/src/agents/agents.module.ts` — register `CursorCliProvider` (not in `available()`)
- `apps/server/src/agents/agents.registry.ts` — add `get(id)` lookup (if not already present); ensure `available()` excludes `cursor-cli`
- `apps/server/src/sessions/sessions.service.ts` — branch `steer()` on `cursor_backend`
- `apps/server/src/settings/settings.registry.ts` — add `NUNCIO_CURSOR_AGENT_BIN` setting (optional, default: resolve via PATH)

**Delete:** none.

## Implementation steps

1. TDD `cursor-cli-stream.parser.spec.ts` with fixture lines from Phase 0 findings:
   - `system/init` → null (skip)
   - `user` → null (skip — we already have the user message)
   - `assistant` + `timestamp_ms` + no `model_call_id` → `assistant_delta`
   - `assistant` without `timestamp_ms` → null (dedupe)
   - `result` success → `assistant_message`
   - `result` error → `error`
   - malformed JSON → null (skip + log)
2. Implement `cursor-cli-stream.parser.ts`.
3. TDD `cursor-cli.provider.spec.ts` with a stub `child_process.spawn` that emits fixture lines:
   - Happy path: deltas → final → IDLE
   - Error path: stderr + exit 1 → ERROR
   - Dispose mid-run: subprocess killed
   - `isAvailable()`: binary missing → false
4. Implement `cursor-cli.helpers.ts` (resolve binary, build args from `AgentRunContext`).
5. Implement `CursorCliProvider` extending `BaseAgentProvider`.
6. Register in `AgentsModule`; update `AgentRegistry` to exclude from `available()`.
7. Update `SessionsService.steer()` routing.
8. Add `NUNCIO_CURSOR_AGENT_BIN` to settings registry (optional, secret=false).
9. `bun run test` + `bun run lint` green.

## todo

- [ ] TDD stream parser spec + impl
- [ ] TDD provider spec with stub spawn
- [ ] `cursor-cli.helpers.ts` (binary resolution + arg builder)
- [ ] `CursorCliProvider` impl (spawn, parse, emit, dispose)
- [ ] Register in `AgentsModule`; exclude from `AgentRegistry.available()`
- [ ] `SessionsService.steer()` routing on `cursor_backend`
- [ ] `NUNCIO_CURSOR_AGENT_BIN` setting
- [ ] `bun run test` + `bun run lint` green

## Success criteria

- Unit tests: parser maps all stream-json types correctly; provider happy/error/dispose paths green.
- Manual smoke: handoff a real chat (Phase 2) → steer via API → SSE on phone streams tokens → final `assistant_message` → session IDLE.
- No orphan subprocess after `dispose()` / archive.
- SDK provider unaffected (existing cursor tests still green).

## Risk assessment

| Risk | Mitigation |
|------|------------|
| `agent` not on PATH when server runs as launchd/Tailscale service | `NUNCIO_CURSOR_AGENT_BIN` setting + absolute default `~/.local/bin/agent` |
| Cold start latency frustrates users | Emit a `status { phase: 'cli-starting' }` event so UI can show "Resuming Cursor chat…" |
| Subprocess leaks on server restart | `main.ts` shutdown hook already exists — extend to kill all `activeProcesses` |
| `--trust --force` runs arbitrary shell | Sandbox: rely on Cursor's own `--sandbox` flag; document in Security below; consider `--sandbox enabled` default |
| CLI version changes stream-json schema | Parser defensive: unknown types → null + log; don't crash |
| Concurrent steer on same chatId | Base class already serializes per session (one RUNNING at a time) |

## Security considerations

- `--trust --force` gives the agent full shell + write access in `cwd`. **Mitigations:**
  1. Default to `--sandbox enabled` if the CLI supports it for this flow (verify in Phase 0).
  2. `cwd` is always the session's `workspace` (the user's repo) — never the server's cwd.
  3. Document the trust scope in `AGENTS.md` and the picker UI.
- Never pass `--api-key` on the command line (visible in `ps`); rely on CLI's saved login (`agent login`).
- stderr may contain file contents (CLI prints code frames on errors) — log redact or truncate.
- Subprocess inherits a minimal env (strip `NUNCIO_SETTINGS_KEY`, secret settings).

## Next steps

- Phase 4 hydrates the old transcript so the phone shows history before the first steer.
- Phase 5 wires the UI.
