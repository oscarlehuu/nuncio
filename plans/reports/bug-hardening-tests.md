# Bug-hardening tests

Date: 2026-07-14  
Worktree: `0xo6`

Raise bug-catching power (not line %), via conformance/reconnect + pure UI projections + smoke.

## Track A — Conformance + reconnect

| Item | Status | Notes |
|---|---|---|
| A1 `steerWhileRunning` contract honesty | Done | `provider-contract.suite.ts` + Pi/Claude `arrangeMidRunSteer`; Codex/Cursor/Mock declared-off |
| A2 restart + queue combined | Done | `sessions.restart-queue-combined.spec.ts` |
| A3 two WS clients | Done | `sessions.ws-two-clients.spec.ts` |
| A4 `server_shutdown` resync | Done | Handled in **shared browser pool** (`session-relay-shared-connection.ts`) so multiplexing is preserved; pool + `use-session-stream` specs; docs row 4 updated |

Focused server gate: **44 pass / 0 fail** (5 contracts + restart-queue-combined + ws-two-clients).

## Track B — Projections + smoke

| Item | Status | Notes |
|---|---|---|
| B1 `deriveComposerEnabled` | Done | `@nuncio/core` + web shim; `session-detail` uses it |
| B2 `deriveVerifyStatus` → core | Done | Moved; web one-line re-export |
| B3 `deriveStatusDotTone` | Done | Core + `status-dot.tsx` maps tone → classes |
| B4 queued-steer rows | Done | Extended `transcript-build-blocks.spec.ts` |
| B5 smoke-ui | Done | Composer enabled after IDLE; Light theme screenshot via ThemeProvider storage key (ModeToggle hit-target blocked by sidebar rail); interrupt mid-run **skipped** on Mock; pending-input smoke skipped |

Focused server gate: **44 pass / 0 fail**.  
Core: **414 pass**. Targeted web: **118 pass**.  
`bun run test:smoke-ui`: **PASS** (Solo + delegation + Crew + new composer/theme steps).

## Verify commands

```bash
cd apps/server && bun test test/unit/agents/pi-agent.contract.spec.ts \
  test/unit/agents/claude-agent.contract.spec.ts \
  test/unit/agents/codex-agent.contract.spec.ts \
  test/unit/agents/cursor-agent.contract.spec.ts \
  test/unit/agents/mock-agent.contract.spec.ts \
  test/unit/sessions/sessions.restart-queue-combined.spec.ts \
  test/unit/sessions/sessions.ws-two-clients.spec.ts
bun run --filter @nuncio/core test
bun run --filter @nuncio/web test -- src/components/status-dot.spec.tsx \
  src/components/session-detail.spec.tsx src/lib/use-session-stream.spec.tsx
bun run test:smoke-ui
```

## Residual gaps

- Mock cannot exercise mid-run Stop/Interrupt in smoke (capability off + instant settle).
- Pending-input composer lock: unit-covered via `deriveComposerEnabled`; no smoke injection without a test-only API.
- ModeToggle click path not exercised in smoke (sidebar rail intercept); light paint proven via storage key + class toggle.
- Cursor-CLI still outside the shared contract harness.
- Mobile `onNotice` freeze path unchanged (dedicated socket); browser pool owns web `server_shutdown` resync.
