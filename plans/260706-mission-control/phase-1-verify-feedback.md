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
  `{ round: number, reason: 'verify_failed', outputTail: string, command: string, retryId: string }`.
  `round` is 1-based (the round *about to run*); `retryId` correlates this marker with the
  `steer_message` it produces (same `retryId` on both, so a boot scan re-sending a dangling steer is
  idempotent). This is the durable record that "an auto-retry was triggered", distinct from the human
  `steer_message` it produces.
- **`verify_needs_attention`** — appended when the loop stops without a green verify. Payload:
  `{ rounds: number, reason: 'max_rounds' | 'repeated_failure', lastOutputTail: string }`.
  This is the "needs you" signal — a client (inbox/chip) keys on it. It is emitted **once** per
  exhausted loop and is cleared implicitly when a later `verify_result ok:true` lands (a fold, below).

The auto-steer itself is delivered through the normal `steer(...)` path, so it produces a
`steer_message` event — but that event is **explicitly tagged** as auto-originated (see below), *not*
inferred from adjacency.

### Distinguishing auto-steers from human steers — explicit origin, not adjacency

An earlier draft said "the `verify_retry` marker sits immediately before the auto `steer_message`, so
a fold can classify by adjacency". **That is wrong and is fixed here.** `BaseAgentProvider.runOrSteer`
emits `status: RUNNING` *before* the `steer_message`
(`apps/server/src/agents/agents.base-provider.ts:217-225`), so the event immediately preceding an auto
`steer_message` is a `status` event, not the `verify_retry` marker — and a human steer produces the
identical `status → steer_message` shape. An adjacency rule would misclassify.

**Fix:** auto-steers carry an explicit origin. The `steer` path gains an internal option so the
auto-retry passes `{ origin: 'verify_retry', retryId }`; the emitted `steer_message` payload then
carries `origin: 'verify_retry'` and the correlating `retryId` (a `verify_retry` marker carries the
same `retryId`). A human steer has no `origin` field (or `origin: 'user'`). Every classification —
the round-count fold, the manual-steer-reset boundary, replay ordering — keys on the **explicit
`origin`/`retryId`**, never on event adjacency. This is asserted directly in the suite.

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
- **Boundary events** (stop the fold at the first of these, exclusive):
  - a `verify_result` with `ok:true` (loop succeeded — reset), OR
  - a `steer_message` **without** `origin: 'verify_retry'` (a human steer — fresh intent, reset), OR
  - a `verify_needs_attention` (a prior loop already surfaced — this is a *new* loop; the count
    starts fresh and, critically, the same needs-attention is not re-emitted — idempotency, below).
- Count the `verify_retry` events seen before that boundary. That count is "rounds already spent" in
  the current loop.

Because the classification uses the explicit `origin` tag (not adjacency), a human `steer_message`
is unambiguous even though `status: RUNNING` sits between it and any prior marker.

This means:
- **Restart mid-retry** rebuilds the exact count by re-folding — the marker events are durable in
  SQLite (ADR-006 append-only log). No in-memory counter to lose.
- **Reset on green** is automatic: once a `verify_result ok:true` lands it becomes the fold boundary,
  so the next failure starts counting from zero again.
- **needs_attention is idempotent**: `verify_needs_attention` is itself a fold boundary, so once it is
  written the fold above it sees zero `verify_retry` markers for the "current loop" and the evaluate
  step does not re-emit it on boot or on a re-check. A duplicate is only possible if a *new* loop
  (a fresh verify failure after a green result or human steer) exhausts its budget again — which is a
  correct, distinct signal.

Rejected alternative: a guarded `ALTER TABLE sessions ADD COLUMN verify_retry_round`. Correct and
ADR-006-compliant, but it stores derived state that can drift from the log and needs its own reset
logic on green/manual-steer. The fold is the single source of truth and matches the "rebuild from the
log" pillar. If profiling later shows the fold is hot, a cached column is the documented escape hatch.

## Boot scan — resuming an interrupted loop (finding #5)

Today's boot (`SessionsService` constructor) does two relevant things: `reconcileInterruptedSessions`
settles rows stuck `RUNNING` on IDLE (`sessions.service.ts:1083`), and `restorePendingSteerQueues`
re-delivers queued steers (`:1100`). **Neither resumes a verify-feedback loop**: a session that
settled IDLE with its last durable event a failed `verify_result` (or a `verify_retry` written but its
auto-steer never sent, because the daemon died in between) has nothing that continues the loop after a
restart. Without a boot scan the loop silently stalls — a betrayal of the restart pillar.

**Design:** add a boot step `resumeVerifyLoops()` that, for each non-archived IDLE session, folds the
event log (the same fold as the round counter) and re-drives the loop from where it left off. The
deterministic crash points and their required boot behaviour:

| Last durable event before crash | Fold sees | Boot action |
|---|---|---|
| failing `verify_result`, no `verify_retry` yet | 0 retries spent, loop live | evaluate: emit `verify_retry` + auto-steer (or `verify_needs_attention` if `max_rounds`/futility already met) |
| `verify_retry` written, auto `steer_message` **not** sent | N retries, but the last retry has no matching steer | re-send the auto-steer for the dangling `retryId` (idempotent: keyed on `retryId`, so a re-scan never double-steers) |
| auto `steer_message` sent, run interrupted mid-turn | reconcile settles it IDLE → its `maybeVerify` at next settle continues the loop | the RUNNING-reconcile path plus this scan converge; no double count |
| `verify_needs_attention` already written | it is a fold boundary; 0 retries "current loop" | **no-op** — idempotent, never re-emit |
| `verify_result ok:true` (green) | fold boundary | no-op |

The scan must be **idempotent** (safe to run every boot) and **feature-gated** (does nothing when
`NUNCIO_VERIFY_AUTO_STEER` is off). Idempotency comes from the fold + `retryId` correlation: the boot
action is a pure function of the durable log, so re-running it produces the same next step, never a
duplicate `verify_retry`/`verify_needs_attention`.

## Task-lane settlement — a task waits for the whole loop (finding #6)

`TasksService.execute` today awaits `sessions.awaitRun()` **once** then records `lastVerifyResult` and
finishes the task (`tasks.service.ts:179-186`). But `awaitRun` tracks only the `startRun` promise
(`sessions.service.ts:997,1017`) — it does **not** track steer-triggered runs, and the auto-steer from
`maybeVerify` is fire-and-forget. So a queued task would finish on the **first red verify**, recording
a failed `verify` and status `DONE`/`FAILED`, *before* the auto-fix loop even runs — defeating the
whole point of rung 1 for the task lane.

**Design:** the task's outcome must wait for **loop settlement**, not just the first run. Introduce a
`SessionsService.awaitVerifySettled(sessionId)` (name illustrative) that resolves only when the fold
reaches a terminal state — a `verify_result ok:true`, a `verify_needs_attention`, or "no verify
command configured / loop disabled" (in which case it degrades to today's single `awaitRun`). The task
runner awaits *that* instead of a bare `awaitRun`, then records the terminal verify result. Mechanics:
the loop's fire-and-forget steers each register their own promise (extend `runPromises` to cover
steer-driven runs, or have the loop expose a per-session settlement promise/emitter), so settlement is
observable. A tasks-level test asserts a task whose verify fails-then-passes finishes `DONE` with the
**green** verify, and a task that exhausts rounds finishes with the needs-attention outcome — not the
first red result.

This is the one place the loop touches another module's contract (`awaitRun` consumers): the change is
**additive** (a new await method), and `TasksService.execute` is the only caller updated. `awaitRun`
itself keeps its current meaning for existing callers.

## Settings surface

Two new entries in `settings.registry.ts` (category `agents`, next to `NUNCIO_VERIFY_COMMAND`):

- **`NUNCIO_VERIFY_AUTO_STEER`** (`boolean`) — master on/off for the feedback loop. When off, the
  gate behaves exactly as today (annotate only). **Default: see founder decision below.**
- **`NUNCIO_VERIFY_MAX_ROUNDS`** (`string`, parsed as int) — max auto-retry rounds before surfacing
  needs-attention. **Default `3`.** Parsed defensively: non-numeric or `< 0` clamps to the default;
  `0` means "surface immediately on first fail, never auto-steer" (the disable-equivalent lower
  bound). An unbounded loop is never possible.

Resolution reuses `SettingsService.resolve` (DB → env → default), so both are runtime-configurable
and env-overridable with zero API/schema change — same pattern the verify command uses. The loop
**must read both flags through `SettingsService.resolve`**, never `process.env` directly: a DB
override has to beat an env var (that is the documented resolution chain), and the settings suite
asserts exactly this so a `process.env`-only shortcut fails the tests.

Boolean parsing for `NUNCIO_VERIFY_AUTO_STEER`: `'1'`/`'true'` (case-insensitive) → on; everything
else (`'0'`, `''`, unset, garbage) → off. `NUNCIO_VERIFY_MAX_ROUNDS` parse: `Number.parseInt`; a
finite integer `>= 0` is honoured, anything else (`NaN`, negative, non-numeric, float) clamps to the
default `3`. `0` is a legal value meaning "surface `verify_needs_attention` immediately on the first
failure, never auto-steer" — the disable-equivalent lower bound. An unbounded loop is impossible.

## User steer priority (decision, documented + reversible)

If the founder **manually steers** the session between auto-retry rounds, the human takes priority:
the human steer runs as a normal turn. **This suite encodes: a manual steer RESETS the auto-retry
counter** — the founder has re-expressed intent, so the next verify failure starts a fresh N-round
budget rather than resuming a nearly-exhausted one. Implemented via the fold boundary: a
`steer_message` **without** `origin: 'verify_retry'` terminates the fold, so subsequent counting
starts at zero. This is robust to the `status: RUNNING` event the provider emits between the marker
and the steer (finding #1), because the boundary keys on the explicit `origin` tag, not adjacency.

**Manual steer after `verify_needs_attention`** (new): the loop has already surfaced and stopped.
A subsequent human steer starts a **brand-new loop** — its next verify failure gets a fresh N-round
budget — rather than staying silent. Same RESET philosophy: the founder nudging means "keep trying".
Encoded as the recommended default; the founder-flag below covers the alternative (stay stopped until
the flag is explicitly re-armed).

Reversibility: the alternative (manual steer *cancels* the loop entirely, leaving the founder in
control until they opt back in) is a one-line policy change in the fold/evaluate step. Encoded as
RESET because "founder nudges, agent keeps trying" matches the attention-router thesis better than
"founder nudges, agent goes silent". Flag for founder if they prefer cancel.

## Futility guard (early stop) — exact semantics

Two **consecutive auto-retry rounds** produce the **byte-identical** failing `outputTail` ⇒ the agent
is not making progress; stop early with `verify_needs_attention` `reason: 'repeated_failure'`.

Pinned semantics (asserted, not prose):
- "Consecutive" is measured over the **`verify_result` events of the current loop** (fold-scoped), in
  order. Compare each failing result's `outputTail` to the immediately preceding failing result's
  `outputTail` *within the same loop*.
- The guard needs **at least two failing `verify_result`s** to trip — it can never stop after the very
  first failure (that path is owned by `max_rounds = 0`). Concretely: with a script that emits the
  identical failure every time and `max_rounds = 5`, the loop stops at **exactly 2** `verify_retry`
  markers (round 1 auto-steers, round 2's identical result trips the guard), not 1 and not 5.
- Comparison is exact string equality on the captured `outputTail` (already length-capped at 4000
  chars in `runVerifyCommand`). A single differing byte counts as progress and the loop continues to
  the `max_rounds` budget.
- The emitted event carries `{ rounds, reason: 'repeated_failure', lastOutputTail }` where `rounds` is
  the number of auto-retry rounds actually spent and `lastOutputTail` is the repeated failure output.

This is a cheap, provider-agnostic progress heuristic; richer heuristics (diff size, verify duration
trend) are a rung-3 radar concern, out of scope here.

## Edge-case matrix

The full matrix lives in the task ledger
(`.claude/maestro/verify-feedback-loop/edge-cases.md`) and drives the red suite. Summary of the
must-survive cases: pass-first-try (no steer), fail→fix→reset, fail-all-N (stop at N, never N+1),
manual steer resets counter, restart mid-retry rebuilds count, verify crash/timeout counts as a
failed round, identical-output futility stop, feature-disabled == today, provider-agnostic via mock,
seq-cursor replay coherence, plus documented contracts for empty/large output, zero/negative
max-rounds, re-entrancy, and archived-mid-retry.

## Verify (for this task)

- Server specs:
  - `apps/server/test/unit/sessions/sessions.verify-feedback.spec.ts` — core loop behaviour
    (pass/fail-fix/fail-all-N/futility/disabled/seq-replay/empty+oversized output/explicit-origin/
    max-rounds-0/needs-attention idempotency/steer-after-needs-attention/provider failure mid-steer).
  - `apps/server/test/unit/sessions/sessions.verify-feedback-restart.spec.ts` — restart / event-log
    fold / deterministic crash-point resume / manual-steer reset (deterministically gated) /
    archive-pause-delete-in-flight / human-steer-while-verify-running / provider-agnostic via a
    provider-neutral fake.
  - `apps/server/test/unit/settings/settings.verify-feedback.spec.ts` — settings contract: registry
    presence, DB override beats env, boolean parsing, max-rounds `0`/negative/non-numeric.
  - `apps/server/test/unit/tasks/tasks.verify-feedback.spec.ts` — task-lane settlement: a task waits
    for loop settlement, records the green/needs-attention outcome not the first red verify.
- `bun test` runs them; in this red phase they FAIL for missing-feature reasons (no `verify_retry` /
  `verify_needs_attention` events, no auto-steer, no settings keys, no loop-settlement await), not
  syntax errors. The pure-invariant tests (pass→no-steer, disabled==today) stay GREEN.
- `bun run --filter @nuncio/server lint` clean.

## Founder decisions (flagged, NOT decided here)

1. **Default-enabled scope.** Should `NUNCIO_VERIFY_AUTO_STEER` default **on globally** (every project
   with a verify command auto-retries), or **off globally with per-session opt-in**, or **per-project
   via `.nuncio/`**? Recommended default: **off globally for the first ship**, opt-in while
   dogfooding, flip to on-by-default once the loop is proven — this respects "annotate don't surprise"
   and lets the founder live it before it runs unattended. A per-session/per-project override is a
   natural rung-2 addition (project entity) but not required for rung 1.
2. **Manual-steer semantics.** RESET (encoded) vs CANCEL the auto-retry loop — applies both
   *between rounds* and *after `verify_needs_attention`*. Recommended default: RESET (the founder
   nudging means "keep trying"); a manual steer after needs-attention starts a fresh loop.
3. **needs-attention delivery.** This phase only emits the *event*. Whether it also pushes a phone
   notification / lands in the rung-3 approvals inbox is deferred to rung 3; the event is the seam.

## Review responses (spec review, Codex gpt-5.5 xhigh — REVISE)

Every blocking finding was verified against the actual code before applying. All 7 were factually
correct against `main`; none refuted. Summary of what each turned into:

1. **Auto-marker adjacency is wrong** — verified: `agents.base-provider.ts:217-225` emits
   `status: RUNNING` before `steer_message`. Fixed to an **explicit `origin: 'verify_retry'` + retryId**
   on the steer/marker; the fold and all classification key on the tag, never adjacency. Asserted.
2. **Auto-steer text unproven** — added assertions that the auto `steer_message.text` contains the
   verify command and the failure `outputTail` (and a "no output captured" note on the empty case).
3. **Futility under-asserted** — pinned exact semantics (≥2 failing results in-loop, byte-identical
   tail, stops at exactly 2 retries with `max_rounds=5`) and assert `rounds` + `lastOutputTail`.
4. **Settings untested** — added `settings.verify-feedback.spec.ts`: registry presence, DB-beats-env,
   boolean parse, max-rounds `0`/negative/non-numeric. The loop reads via `SettingsService.resolve`.
5. **Restart continuation** — verified boot only reconciles RUNNING rows + queued steers
   (`sessions.service.ts:1083,1100`); nothing resumes an IDLE-after-failed-verify session. Added the
   **boot-scan** design + deterministic crash-point table and tests.
6. **Task settlement** — verified `tasks.service.ts:179-186` awaits `awaitRun` once (which tracks only
   `startRun`, `sessions.service.ts:997`) then records the first verify. Added the
   **`awaitVerifySettled`** design + a tasks-level test that a fail-then-pass task finishes green.
7. **Manual-steer reset race** — verified `awaitRun` does not track steer runs. Added a deterministic
   gate (a verify script that blocks on a fifo/marker file) so the manual steer lands exactly between
   auto rounds, removing the timing race.

Suggestions: (1) tests now preserve+restore prior env values instead of blind-deleting. (2) the
"crash" case is renamed to **"non-zero exit"** (`exit 127` is an ordinary non-zero exit, `ok:false`
via `runVerifyCommand`, not a spawn throw). A **genuine `runVerifyCommand` throw** turns out not to be
reachable through a real `.nuncio/verify`: `resolveVerifyCommand` spawns `['sh', script]` /
`['sh','-c',inline]` and `sh` always exists, so `Bun.spawn` does not throw — the throw path
(`sessions.service.ts:1045`) is only hit if the shell itself is missing. It is therefore kept as a
**design contract** (a thrown `runVerifyCommand` == `ok:false` failed round, already handled by
`maybeVerify`'s catch and exercised by the shipped verifier-gate spec), alongside the timeout contract
(a 5-minute live test is infeasibly slow). Both are noted in the ledger with their reason. (3)
provider-agnosticism — see the ADR-004 checklist above; taken the checklist branch of the review's OR
plus the mock drive, reason recorded. (4) full payload shapes for both new events are asserted.

## Open conflicts

None found. The design fits the existing invariants:
- **FSM (ADR-003):** untouched — the loop is pure event-log annotation plus reuse of the existing
  `steer` path; no new `sessions.status` transitions.
- **Steer-queue semantics:** the auto-steer uses the same `steer(...)` entry point, so a session that
  is RUNNING when an auto-steer would fire queues it exactly as a human steer would (the
  `verifying`/IDLE guards in `maybeVerify` mean this is rare, but the semantics are consistent).
- **ADR-006:** no schema change; state is derived from the append-only log.
- **ADR-004 (engine test — enforcement checklist for the implementer):**
  - the loop lives entirely in `SessionsService`/`session-verifier` and reaches engines only through
    `AgentProvider.steer(...)`;
  - **grep the implementation diff for `=== 'pi'` / `=== 'cursor'` / `=== 'codex'` / `=== 'mock'`** —
    there must be zero engine-id comparisons outside `providers/`;
  - the red suite drives the whole loop through the `mock` provider (a `BaseAgentProvider` with no
    engine-specific code) as well as the simulated cursor, proving neutrality behaviourally.

  Note on the review's "arbitrary-id fake" option: the `AgentRegistry` provider list is fixed
  (`agents.registry.ts:34`), so injecting a genuinely arbitrary id needs an `AgentRegistry` override
  that would add brittle test scaffolding for little extra signal over the mock (which is already
  engine-neutral). The review offered this as an **OR** with "add ADR-004 to the review checklist" —
  taken the checklist branch (above) plus the mock drive, and recorded the reason here.
