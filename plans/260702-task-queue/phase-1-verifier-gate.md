# Phase 1 — Verifier Gate

**Status:** In progress · **Depends on:** nothing (per-session value before any queue exists)

## Scope

- **Command resolution (per project first):** `<workspace>/.nuncio/verify` (shell script, run via `sh`) wins; the `NUNCIO_VERIFY_COMMAND` setting is the machine-wide fallback; no command → no verify, zero overhead.
- **Run on turn end:** after a local `run`/`steer` settles with the session on `IDLE`, the sessions service runs the command in the session's working directory (worktree → workspace → project) detached from the request cycle.
- **Annotate, don't block (locked decision):** the FSM is untouched. The gate appends `verify_start` then `verify_result` (`ok`, `exitCode`, `durationMs`, `outputTail`, `timedOut`) to the event log; a failing suite shows red, it never wedges the session.
- **Timeout:** 5 minutes, reported as `timedOut: true`, `ok: false`.
- **Web chip:** last verify event drives a chip (running / passed / failed) in the session header and on grid tiles.

## Out of scope

- Task queue itself (phase 2), retry policies, per-session verify overrides.
- Gating merge/PR actions on verify results.

## Verify

- Server specs: command resolution precedence, run success/failure/timeout, service appends verify events only when a command exists and the session ended IDLE.
- Web specs: chip derivation from events + rendering in session detail and tile.
- Manual: `.nuncio/verify` with `bun test` in a real project, steer a session, watch the chip flip.
