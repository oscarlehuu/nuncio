# Phase 00 — Spike & Contract Validation

**Priority:** P0 (blocker — gates every later phase)
**Status:** Not started
**Depends on:** nothing
**Estimated:** 0.5 day

## Context Links

- [Plan overview](./plan.md)
- `AGENTS.md` → "Cursor SDK under Bun" gotchas
- Cursor CLI docs: https://cursor.com/docs/cli/using

## Overview

Lock every assumption about CLI resume + transcript paths **before** writing implementation code. If the spike fails, the plan pivots (e.g. to transcript-replay-only without real resume). No production code lands here — just probes + a short findings doc.

## Key insights to verify

1. `chatId` = folder name in `~/.cursor/projects/<slug>/agent-transcripts/<chatId>/`. Already confirmed on this Mac.
2. `agent -p --trust --force --resume <chatId> --workspace <absPath>` actually resumes IDE conversation (not just CLI chats). Already confirmed once (`c50dad89-…` → "CONTINUE-OK").
3. `--output-format stream-json --stream-partial-output` emits token deltas we can map to `assistant_delta`.
4. `agent ls` is TUI-only (Ink raw mode) — cannot be used headless. Confirmed.
5. Workspace path must be absolute and match the transcript's project slug.
6. IDE agent RUNNING while CLI resumes → does it conflict, queue, or error?

## Requirements

### Functional
- A reproducible shell probe that resumes a known chat ID and streams output.
- A short findings document capturing the exact command, exit codes, stream format, and failure modes.

### Non-functional
- No new dependencies.
- No changes to Nuncio runtime.

## Architecture

N/A — spike only.

## Related code files

**Modify:** none.
**Create:** `plans/260628-handoff-continue-on-mobile/spike-findings.md`
**Delete:** none.

## Implementation steps

1. Pick a real, recent IDE chat ID from `~/.cursor/projects/Users-a1241968-Desktop-Oscar-nuncio/agent-transcripts/`.
2. Run the resume command with `stream-json` and capture 20 lines of stdout.
3. Map each `type` to the Nuncio event contract (`assistant_delta`, `tool_start`, `tool_end`, `assistant_message`, `status`, `error`).
4. Probe failure modes:
   - Wrong workspace path
   - Bogus chat ID
   - `agent` binary missing from PATH (server runs headless — does it inherit the user shell PATH?)
   - IDE agent still RUNNING on the same chat (open Cursor, start a run, then resume from CLI)
5. Confirm `~/.local/bin/agent` resolves from a non-interactive `bun` subprocess (not just login shell).
6. Record the smallest valid spawn args + the stream-json line schema in `spike-findings.md`.

## Todo

- [ ] Resume a real IDE chat from CLI, capture stdout
- [ ] Document stream-json line schema (per `type`)
- [ ] Map stream-json types → Nuncio event types
- [ ] Probe: IDE agent RUNNING → CLI resume conflict behavior
- [ ] Probe: `agent` binary resolution from `bun` subprocess
- [ ] Probe: bogus chatId + wrong workspace error shapes
- [ ] Write `spike-findings.md` with locked command + failure modes

## Success criteria

- `spike-findings.md` exists and contains:
  - The canonical resume command (copy-pasteable).
  - The stream-json schema with at least: `system/init`, `user`, `assistant` (with and without `timestamp_ms`), `result`, `error`.
  - Documented behavior for each failure mode probed.
- A second person (or fresh shell) can run the canonical command and get a streaming response.

## Risk assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| CLI resume does NOT load IDE chat checkpoint | Low (already verified once) | Spike catches it; pivot to transcript-replay-only |
| `agent` not on PATH when server runs as launchd agent | Medium | Resolve via `NUNCIO_CURSOR_AGENT_BIN` setting (Phase 6) or absolute default |
| Concurrent IDE run corrupts CLI resume | Medium | Detect + block in Phase 2/3; document here |
| stream-json format changes across CLI versions | Low | Pin to installed version; re-spike on update |

## Security considerations

- `--trust --force` skips command approval — agent can run any shell command in `cwd`. Spike must confirm sandbox story before Phase 3 ships.
- Resume loads Cursor's saved credentials/tokens — no new secret handling needed, but logs must not print `--api-key` if we pass one.

## Next steps

- If spike passes → Phase 1.
- If CLI resume fails for IDE chats → pivot: Phase 3 becomes "transcript replay only" (no real agent loop); user gets read-only history + a fresh SDK session seeded with the old transcript. Update plan.md before continuing.
