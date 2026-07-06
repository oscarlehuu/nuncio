# Phase 1 — Verify-Feedback Loop (Rung 1)

**Status:** Design + red suite (2026-07-06). Implementation not yet written.
**Depends on:** the shipped verifier gate (`plans/260702-task-queue/phase-1-verifier-gate.md`) —
`verify_start` / `verify_result` events and the `maybeVerify` hook in `SessionsService`.
**North-star row:** Rung 1 in `plans/260706-mission-control/plan.md` — "on `verify_result` fail,
auto-steer the session with the failure output, max N rounds, then surface 'needs you'."

## Goal

Turn the verifier gate from a status light into an engine. When a session's post-turn verify fails,
Nuncio automatically steers the *same session* with the failure output so the agent fixes it — up to
N rounds — then stops and raises a "needs you" signal. A task self-fixes a red verify with zero
founder input.

## The 5 direction tests (product-vision.md)

1. **Phone test** — the needs-attention signal is an event; it drives an inbox/chip the founder sees
   on the phone. No desktop-only surface added.
2. **Engine test** — the loop lives entirely in `SessionsService`, reached through `AgentProvider`.
   Zero `if (provider === 'pi')`. Proven by driving the whole loop through the mock provider.
3. **Forge test** — no forge interaction; N/A but not violated.
4. **Restart test** — the round counter and "loop is active" state are **derived from the event
   log**, never held only in memory. A restart mid-retry rebuilds the count exactly.
5. **Self-host test** — no cloud service; the verify command is local, the loop is in-process.

## Where the hook lives

The verifier already runs in `SessionsService.maybeVerify(sessionId)`, called from `startRun` and
`steer` after a local turn settles IDLE. It appends `verify_start` then `verify_result`
(`{ ok, exitCode, durationMs, outputTail, timedOut }`).

The feedback loop hangs off the **tail of `maybeVerify`**: after appending a *failing* `verify_result`
(including the crash/timeout branch, which is already mapped to `ok:false`), evaluate the retry
policy and, if it says "retry", append an auto-steer marker event and call `this.steer(sessionId,
feedbackMessage)`. Because `steer` itself ends by calling `maybeVerify`, the loop is naturally
self-driving through the existing machinery — no new scheduler, no new FSM state (annotate, never
block; ADR-003 holds).

```
run/steer settles IDLE
  → maybeVerify
      → verify_result ok:true   → (reset happens implicitly: counter is a fold, see below) → done
      → verify_result ok:false  → evaluateRetry(session)
            → retry            → append verify_retry, steer(feedback) → (next turn) → maybeVerify …
            → stop (rounds/futility) → append verify_needs_attention → done
            → disabled         → (nothing; today's behaviour)
```

## How a retry round is represented in the event log

Two new event types (added to `SessionEventType` in `sessions/domain/events.types.ts`):

- **`verify_retry`** — appended immediately before the auto-steer. Payload:
  `{ round: number, reason: 'verify_failed', outputTail: string, command: string }`.
  `round` is 1-based (the round *about to run*). This is the durable record that "an auto-retry was
  triggered", distinct from the human `steer_message` it produces.
- **`verify_needs_attention`** — appended when the loop stops without a green verify. Payload:
  `{ rounds: number, reason: 'max_rounds' | 'repeated_failure', lastOutputTail: string }`.
  This is the "needs you" signal — a client (inbox/chip) keys on it. It is emitted **once** per
  exhausted loop and is cleared implicitly when a later `verify_result ok:true` lands (a fold, below).

The auto-steer itself is delivered through the normal `steer(...)` path, so it produces the same
`steer_message` event a human steer would — clients render it as an agent-directed instruction with a
system origin. The `verify_retry` marker sitting just before it is what distinguishes auto from human.

### The feedback message

The message handed to `steer` is built from the failing `verify_result`, e.g.:

```
The verify step failed (exit <code><, timed out>). Fix the cause and make it pass.
Command: <command>
Output:
<outputTail>
```

`outputTail` is already capped at 4000 chars in `runVerifyCommand`, so the auto-steer never carries an
unbounded stream. On an **empty** outputTail we still steer, with a "no output captured" note, so the
agent is told the check failed even when the tool was silent.

## How the round counter survives restart (ADR-006)

**Chosen: derive from the event log — no schema change.** The retry count for the *current* loop is a
pure fold over the tail of the session's events:

- Walk events newest-to-oldest.
- Stop the fold at the first `verify_result` with `ok:true`, or at a human `steer_message` that is
  **not** preceded by a `verify_retry` (a manual steer starts a fresh intent — see "User steer
  priority").
- Count the `verify_retry` events seen before that boundary. That count is "rounds already spent".

This means:
- **Restart mid-retry** rebuilds the exact count by re-folding — the marker events are durable in
  SQLite (ADR-006 append-only log). No in-memory counter to lose.
- **Reset on green** is automatic: once a `verify_result ok:true` lands it becomes the fold boundary,
  so the next failure starts counting from zero again.
- **needs_attention is idempotent**: before emitting it, check the fold hasn't already emitted one
  for this loop (no green verify since the last `verify_needs_attention`).

Rejected alternative: a guarded `ALTER TABLE sessions ADD COLUMN verify_retry_round`. Correct and
ADR-006-compliant, but it stores derived state that can drift from the log and needs its own reset
logic on green/manual-steer. The fold is the single source of truth and matches the "rebuild from the
log" pillar. If profiling later shows the fold is hot, a cached column is the documented escape hatch.

## Settings surface

Two new entries in `settings.registry.ts` (category `agents`, next to `NUNCIO_VERIFY_COMMAND`):

- **`NUNCIO_VERIFY_AUTO_STEER`** (`boolean`) — master on/off for the feedback loop. When off, the
  gate behaves exactly as today (annotate only). **Default: see founder decision below.**
- **`NUNCIO_VERIFY_MAX_ROUNDS`** (`string`, parsed as int) — max auto-retry rounds before surfacing
  needs-attention. **Default `3`.** Parsed defensively: non-numeric or `< 0` clamps to the default;
  `0` means "surface immediately on first fail, never auto-steer" (the disable-equivalent lower
  bound). An unbounded loop is never possible.

Resolution reuses `SettingsService.resolve` (DB → env → default), so both are runtime-configurable
and env-overridable with zero API/schema change — same pattern the verify command uses.

## User steer priority (decision, documented + reversible)

If the founder **manually steers** the session between auto-retry rounds, the human takes priority:
the human steer runs as a normal turn. **This suite encodes: a manual steer RESETS the auto-retry
counter** — the founder has re-expressed intent, so the next verify failure starts a fresh N-round
budget rather than resuming a nearly-exhausted one. Implemented via the fold boundary: a
`steer_message` not preceded by a `verify_retry` marker terminates the fold, so subsequent counting
starts at zero.

Reversibility: the alternative (manual steer *cancels* the loop entirely, leaving the founder in
control until they opt back in) is a one-line policy change in the fold/evaluate step. Encoded as
RESET because "founder nudges, agent keeps trying" matches the attention-router thesis better than
"founder nudges, agent goes silent". Flag for founder if they prefer cancel.

## Futility guard (early stop)

If two consecutive auto-retry rounds produce the **identical** failing `outputTail`, the agent is not
making progress. Stop early — emit `verify_needs_attention` with `reason: 'repeated_failure'` — rather
than burning the remaining rounds on a stuck loop. Comparison is on the captured `outputTail` string
(already length-capped). This is a cheap, provider-agnostic progress heuristic; richer heuristics
(diff size, verify duration trend) are a rung-3 radar concern, out of scope here.

## Edge-case matrix

The full matrix lives in the task ledger
(`.claude/maestro/verify-feedback-loop/edge-cases.md`) and drives the red suite. Summary of the
must-survive cases: pass-first-try (no steer), fail→fix→reset, fail-all-N (stop at N, never N+1),
manual steer resets counter, restart mid-retry rebuilds count, verify crash/timeout counts as a
failed round, identical-output futility stop, feature-disabled == today, provider-agnostic via mock,
seq-cursor replay coherence, plus documented contracts for empty/large output, zero/negative
max-rounds, re-entrancy, and archived-mid-retry.

## Verify (for this task)

- Server specs under `apps/server/test/unit/sessions/`:
  - `sessions.verify-feedback.spec.ts` — the loop behaviour through the simulated cursor + mock
    providers.
  - `sessions.verify-feedback-restart.spec.ts` — the restart / event-log-fold cases.
- `bun test` runs them; in this red phase they FAIL for missing-feature reasons (no `verify_retry` /
  `verify_needs_attention` events, no auto-steer), not syntax errors.
- `bun run --filter @nuncio/server lint` clean.

## Founder decisions (flagged, NOT decided here)

1. **Default-enabled scope.** Should `NUNCIO_VERIFY_AUTO_STEER` default **on globally** (every project
   with a verify command auto-retries), or **off globally with per-session opt-in**, or **per-project
   via `.nuncio/`**? Recommended default: **off globally for the first ship**, opt-in while
   dogfooding, flip to on-by-default once the loop is proven — this respects "annotate don't surprise"
   and lets the founder live it before it runs unattended. A per-session/per-project override is a
   natural rung-2 addition (project entity) but not required for rung 1.
2. **Manual-steer semantics.** RESET (encoded) vs CANCEL the auto-retry loop. Recommended default:
   RESET.
3. **needs-attention delivery.** This phase only emits the *event*. Whether it also pushes a phone
   notification / lands in the rung-3 approvals inbox is deferred to rung 3; the event is the seam.

## Open conflicts

None found. The design fits the existing invariants:
- **FSM (ADR-003):** untouched — the loop is pure event-log annotation plus reuse of the existing
  `steer` path; no new `sessions.status` transitions.
- **Steer-queue semantics:** the auto-steer uses the same `steer(...)` entry point, so a session that
  is RUNNING when an auto-steer would fire queues it exactly as a human steer would (the
  `verifying`/IDLE guards in `maybeVerify` mean this is rare, but the semantics are consistent).
- **ADR-006:** no schema change; state is derived from the append-only log.
- **ADR-004:** no engine branch; the loop is provider-neutral and proven via the mock provider.
