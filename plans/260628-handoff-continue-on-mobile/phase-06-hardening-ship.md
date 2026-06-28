# Phase 06 — Hardening & Ship

**Priority:** P1 (shipping gate)
**Status:** Not started
**Depends on:** Phases 1–5 functionally complete
**Estimated:** 1 day
**Lane:** A + B + C

## Context Links

- [Plan overview](./plan.md)
- `AGENTS.md` → "Working practice: TDD-first" step 6 (changeset gate)
- `AGENTS.md` → "Code review gate"

## Overview

Take the feature from "works on my Mac" to "shippable to friends on the tailnet." Edge cases, error UX, dedupe correctness, docs sync, changeset, full test gate, manual smoke on Tailscale.

## Key insights

- The riskiest edge case is **concurrent IDE run**: user starts a run in Cursor IDE, walks out, opens Nuncio, steers the same chat from CLI. Two agents on one checkpoint store can corrupt or double-run.
- Second risk: `agent` binary not on PATH when the server runs as a background service (launchd / Tailscale serve context).
- Changeset is mandatory (user-facing feature) per `AGENTS.md`.
- Docs sync (`README.md` + `AGENTS.md`) is part of "done."

## Requirements

### Functional
- **Active-run detection:** before CLI steer, detect if Cursor IDE has a run in progress on the same `chatId`. If yes → block with a clear error ("Cursor is still running this chat on your Mac — pause it first"). Detection strategy: check the transcript folder for a lock file or recent mtime within last N seconds (verify in Phase 0; fallback: heuristic on `store.db` mtime).
- **Binary resolution:** `NUNCIO_CURSOR_AGENT_BIN` setting → `~/.local/bin/agent` default → PATH lookup. Clear error if none.
- **Dedupe:** re-importing the same `chatId` always returns the existing session (already in Phase 2 — verify with an integration test).
- **Error UX:** CLI missing, chatId gone, workspace invalid, CLI exit ≠ 0 — each maps to a user-readable message on the phone, not a stack trace.
- **Subprocess cleanup on shutdown:** `main.ts` shutdown hook kills all `CursorCliProvider.activeProcesses`.
- **Sandbox default:** if Phase 0 confirms `--sandbox enabled` works with resume, default to it; document the trust scope.

### Non-functional
- `bun run test` (server unit) + `bun run test:e2e` + `bun run --filter @nuncio/web test` + `bun run lint` + `bun run build` all green.
- Code review pass (code-reviewer agent or Bugbot) — blockers fixed, warnings documented.
- Changeset fragment committed.
- `README.md` + `AGENTS.md` updated.

## Architecture

No new modules. Touches:

- `main.ts` — shutdown hook for `CursorCliProvider` subprocesses.
- `cursor-cli.provider.ts` — active-run pre-check.
- `sessions.service.ts` — handoff error mapping (404/409/500 → user messages).
- Frontend error toasts in `handoff-picker.tsx` (sonner already wired).

## Related code files

**Modify:**
- `apps/server/src/main.ts` — shutdown hook
- `apps/server/src/agents/providers/cursor-cli.provider.ts` — active-run pre-check + binary resolution hardening
- `apps/server/src/sessions/sessions.service.ts` — typed errors for handoff/steer
- `apps/web/src/components/handoff-picker.tsx` — error toasts
- `README.md` — new "Continue on Mac" section (commands, flow, troubleshooting)
- `AGENTS.md` — handoff architecture subsection under "Agent providers"

**Create:**
- `.changeset/<random>.md` — user-facing release note
- `plans/reports/handoff-report.md` — lane report (status, what shipped, verify commands, unresolved)

**Delete:** none.

## Implementation steps

1. Add active-run detection to `CursorCliProvider.executePrompt()` (pre-check before spawn).
2. Harden binary resolution: setting → default absolute → PATH; typed error if missing.
3. Extend `main.ts` shutdown to kill active CLI subprocesses.
4. Map server errors to HTTP status codes: 409 (IDE run in progress), 503 (CLI missing), 404 (chat gone).
5. Frontend: toast on 409/503/404 with actionable copy.
6. Integration test: handoff → steer → archive → re-import (idempotent end-to-end).
7. Run full gate: `bun run test`, `bun run test:e2e`, `bun run --filter @nuncio/web test`, `bun run lint`, `bun run build`.
8. Code review pass; fix blockers.
9. `bun run changeset` → write user-facing summary ("Added 'Continue on Mac' so you can pick an in-progress Cursor chat and keep it going from your phone without losing context.").
10. Update `README.md` + `AGENTS.md`.
11. Write `plans/reports/handoff-report.md`.
12. Manual smoke on Tailscale (phone) against a real in-progress IDE chat.

## todo

- [ ] Active-run detection in `CursorCliProvider`
- [ ] Binary resolution hardening + typed error
- [ ] `main.ts` shutdown hook for CLI subprocesses
- [ ] HTTP error code mapping (409/503/404)
- [ ] Frontend error toasts in picker
- [ ] Integration test: handoff → steer → archive → re-import
- [ ] `bun run test` + e2e + web test + lint + build green
- [ ] Code review pass — blockers fixed
- [ ] Changeset fragment (user-facing)
- [ ] `README.md` + `AGENTS.md` updated
- [ ] `plans/reports/handoff-report.md`
- [ ] Manual smoke on Tailscale phone

## Success criteria

- Full test gate green (server unit + e2e + web + lint + build).
- Code review: no open blockers.
- Changeset committed with a user-perspective release note.
- Docs reflect the shipped feature.
- Manual smoke: real IDE chat → handoff on phone → steer streams → no orphan processes after archive.
- Edge cases handled: IDE run in progress (blocked), CLI missing (clear error), chat deleted (graceful).

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Active-run detection heuristic is flaky | Conservative: block if transcript mtime within last 30s OR store.db locked; allow user override "Force resume" in a later pass |
| Background server can't find `agent` | Default absolute path `~/.local/bin/agent` + setting override; fail fast with 503 + setup instructions |
| Changeset forgotten | Listed in todo + success criteria; CI would flag if a release PR has user-facing changes without one |
| Docs drift | Success criteria includes docs update; reviewer checks |

## Security considerations

- Confirm `--sandbox enabled` is the default if Phase 0 validated it.
- Ensure subprocess env does not leak `NUNCIO_SETTINGS_KEY` or decrypted secret settings.
- Document trust scope in `AGENTS.md`: "Handoff sessions run with `--trust --force` in the workspace cwd — same trust as the user running `cursor` in that repo."

## Next steps

- Merge to `main` → Version PR → release.
- Future enhancements (out of scope this plan): multi-select import, two-way sync, extension button inside Cursor IDE, cloud agent handoff (`bc-` IDs via `Agent.resume`), subagent transcript replay.
