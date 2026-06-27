# Phase: Cursor SDK Provider Integration

**Status:** shipped  
**Branch:** `cursor/cursor-sdk-provider`  
**Date:** 2026-06-27

## What shipped

- `CursorAgentProvider` — local `@cursor/sdk` runtime via `BaseAgentProvider`
- Bun compat escape hatches: `useHttp1ForAgent: true` + `JsonlLocalAgentStore(<string dir>)`
- `workspace` field on session contract + schema (forward-compatible with Phase 4)
- Registry wiring: Pi + Cursor + Mock; cursor opt-in (`defaultId()` unchanged)
- Unit tests: 19 cursor provider specs + workspace specs + registry updates
- Integration test gated on `CURSOR_API_KEY`

## Smoke / docs audit (pre-impl)

- Bun 1.3.14 + `@cursor/sdk@1.0.22`: transport confirmed with fake key + HTTP/1.1
- `Agent.create` is async, hits backend immediately (env-only `isAvailable()`)
- `agent.close()` for sync dispose; `result.result` for final assistant text
- `JsonlLocalAgentStore` constructor takes string dir

## Verify

```bash
cd apps/server && bun test test/unit/          # 78 pass
cd apps/server && bun run lint               # tsc --noEmit green
bun run build                                # server + web green
CURSOR_API_KEY=... bun run test:integration  # opt-in real-key e2e
```

## Unresolved

- Cloud runtime (GitHub repo + PR)
- Per-session git worktree (Phase 4) — workspace field ready, UI not wired
- `Agent.resume()` across server restart
- Real-key integration test requires user-minted `CURSOR_API_KEY`
