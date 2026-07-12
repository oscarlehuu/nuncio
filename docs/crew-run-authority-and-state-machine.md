# CrewRun Authority Boundary and State Machine

**Status:** locked, implemented, and verified baseline for the `dev` integration lane. This is not
a stable-release claim.
**Last synchronized:** 2026-07-10.
**Workspace companion:** [Crew Workspace Harness](crew-workspace-harness.md).

## Authority rule

> Members propose structured work. Nuncio decides what is allowed, validates deterministic
> evidence, and is the only actor that advances the CrewRun. The user owns objective changes and
> explicit interruption decisions.

No model writes the run projection, grants itself tools, certifies a gate, changes its frozen
provider/model, or marks itself complete.

## Actors

### User

Chooses Solo or Crew, the saved profile, objective, project, and base branch. The user supplies a
material clarification, pauses/resumes/cancels a run, grants one gate-specific extra round after a
cap, and requests a successor from a terminal run.

### Nuncio

Owns profile resolution, immutable snapshots, append-only events, compare-and-swap revisions,
member scheduling, per-session runtime policy, context projections, worktree boundaries, the writer
lease, deterministic verification, artifact integrity, review validity, retry caps, recovery,
Attention, quiescence, and terminal outcomes.

### Foreman

Runs read-only. It submits a typed plan or material clarification request, then later submits a
typed synthesis. It cannot acquire write authority or advance the run directly.

### Builder

Runs with the single workspace-write policy and lease. It submits a typed build intent; Nuncio
independently finalizes the clean committed head and stores the authoritative Builder result. The
same logical Builder Session is reused for gate feedback when resumable.

### Nuncio Tester

Is a deterministic process, not a model role. It executes the frozen verify command in Seatbelt on
macOS or bubblewrap on Linux and records head-bound evidence.

### Reviewer

Runs read-only and submits typed current-head findings. It is reused during feedback. A strict
fresh final Reviewer is created only after a review-fix loop reaches a blocker-free reused-reviewer
result.

## Authority matrix

| Decision/action | User | Nuncio | Member |
|---|---|---|---|
| Set objective/project/profile | Chooses | Validates and persists | May identify ambiguity |
| Resolve provider/model | Chooses saved binding | Requires exact live binding and policy | No |
| Decompose and plan | May clarify | Validates typed result and transitions | Foreman proposes |
| Write workspace | May cancel/intervene outside Crew | Grants one Builder lease | Builder only |
| Run verification | May grant an extra round | Executes sandboxed command | Cannot self-certify |
| Set verify gate | No prose override | Deterministic current-head evidence | No |
| Set review gate | No prose override | Validates head and blockers | Reviewer reports findings |
| Retry within cap | May interrupt | Enforces independent cap | Builder continues |
| Exceed one cap | Grants one gate-specific round | Records and dispatches it | Cannot grant |
| Pause/resume/cancel | Authoritative | Quiesces and applies guarded event | Cannot apply |
| Complete run | No direct projection write | Sole authority after all guards | Foreman synthesizes |
| Continue terminal work | Requests exact-head successor | Creates immutable linked run | May resume if compatible |

## Aggregate tuple

Workflow phase, operational status, and terminal outcome are stored separately:

```ts
type CrewRunPhase =
  | 'PLAN'
  | 'BUILD'
  | 'VERIFY'
  | 'REVIEW'
  | 'SYNTHESIZE'
  | 'DONE';

type CrewRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'BLOCKED_USER'
  | 'BLOCKED_PROVIDER'
  | 'PAUSED'
  | 'RECOVERING'
  | 'TERMINAL';

type CrewRunOutcome = null | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
```

`blockedReason` is one of:

- `material_clarification`;
- `verify_round_cap`;
- `review_round_cap`;
- `provider_unavailable`;
- `unrecoverable_failure`;
- `null`.

The exact state is `(phase, status, outcome, blockedReason)`.

## Tuple invariants

The reducer enforces:

1. `DONE` and `TERMINAL` occur together.
2. A terminal tuple has exactly one non-null outcome; every non-terminal tuple has outcome
   `null`.
3. `BLOCKED_USER` always has a typed reason.
4. Revisions and retry/extra-round counters are non-negative integers.
5. Every transition increments the run revision exactly once.
6. Evidence carrying a context revision or workspace head must equal the current projection.
7. The only post-terminal operation is successor creation outside the old run; terminal runs
   reject every reducer event.

## Fixed success path

```text
PLAN/QUEUED
  -> PLAN/RUNNING
  -> BUILD/QUEUED
  -> BUILD/RUNNING
  -> VERIFY/QUEUED
  -> VERIFY/RUNNING
  -> REVIEW/QUEUED
  -> REVIEW/RUNNING
  -> SYNTHESIZE/QUEUED
  -> SYNTHESIZE/RUNNING
  -> DONE/TERMINAL/SUCCEEDED
```

Plan, Verify, Review, and Synthesize are all required. Review fixes return to Build and therefore
must pass through Verify again.

## Exact workflow transitions

| From | Event and guard | To |
|---|---|---|
| `PLAN/QUEUED rev=0` | `run_created`, first event only | `PLAN/QUEUED` |
| `PLAN/QUEUED` | `workspace_prepared`, first non-empty full head | `PLAN/QUEUED` with workspace head |
| `PLAN/QUEUED` | `plan_started` | `PLAN/RUNNING` |
| `PLAN/RUNNING` | `plan_accepted`, typed plan | `BUILD/QUEUED`, context +1 |
| `PLAN/RUNNING` | `clarification_required`, non-empty material reason | `PLAN/BLOCKED_USER/material_clarification`, context +1 |
| `PLAN/BLOCKED_USER` | `clarification_resolved`, exact context revision | `PLAN/QUEUED`, context +1 |
| `BUILD/QUEUED` | `builder_claimed`, canonical boundary and writer lease | `BUILD/RUNNING` |
| `BUILD/RUNNING` | `builder_completed`, exact context revision and finalized full head | `VERIFY/QUEUED`, head replaced, context +1 |
| `VERIFY/QUEUED` | `verify_started`, current head | `VERIFY/RUNNING` |
| `VERIFY/RUNNING` | `verify_passed`, current deterministic evidence | `REVIEW/QUEUED`, context +1 |
| `VERIFY/RUNNING` | `verify_failed`, current head and retry remains | `BUILD/QUEUED`, verify retries +1, context +1 |
| `VERIFY/RUNNING` | `verify_failed`, current head and cap exhausted | `VERIFY/BLOCKED_USER/verify_round_cap`, context +1 |
| `REVIEW/QUEUED` | `reviewer_claimed`, current head and read-only member | `REVIEW/RUNNING` |
| `REVIEW/RUNNING` | `changes_requested`, current blocker and retry remains | `BUILD/QUEUED`, review retries +1, context +1 |
| `REVIEW/RUNNING` | `changes_requested`, current blocker and cap exhausted | `REVIEW/BLOCKED_USER/review_round_cap`, context +1 |
| `REVIEW/RUNNING` | `final_review_requested`, strict post-feedback rule | `REVIEW/QUEUED`, context +1 |
| `REVIEW/QUEUED` | `final_reviewer_claimed`, fresh linked Reviewer and current head | `REVIEW/RUNNING`, context +1 |
| `REVIEW/RUNNING` | `review_passed`, current head, no blocker, freshness satisfied | `SYNTHESIZE/QUEUED`, context +1 |
| `SYNTHESIZE/QUEUED` | `foreman_claimed`, current gates asserted | `SYNTHESIZE/RUNNING` |
| `SYNTHESIZE/RUNNING` | `synthesis_completed`, exact context/head and gates reasserted | `DONE/TERMINAL/SUCCEEDED`, context +1 |

Structured warning findings remain evidence but follow the `review_passed` route. Only blockers
follow `changes_requested`.

## Retry and fresh-review semantics

Verify and review have separate frozen caps. Both default to 2, and the initial gate attempt does
not consume the cap:

```text
verify failure -> same Builder -> Verify          up to 2 automated fix retries
review blocker -> same Builder -> Verify -> Review up to 2 automated fix retries
```

At cap, the run remains on that gate in `BLOCKED_USER`. The only budget mutation is
`extra_round_approved { gate: 'verify' | 'review' }`: it adds one extra round to that gate,
accounts for the dispatched retry, clears the block, and returns to `BUILD/QUEUED`.

Reviewer freshness is narrow:

1. Reuse the current Reviewer during the loop.
2. If no review fix occurred, a blocker-free result advances directly.
3. After at least one review fix, a strict profile turns the first blocker-free reused-reviewer
   result into `final_review_requested`.
4. Nuncio creates a fresh Reviewer incarnation with `priorMemberSessionId`, tied to the same
   current head.
5. Only that fresh blocker-free result advances. If it finds a blocker, the normal review budget
   and Build->Verify->Review loop applies again.

## Operational transitions

| From | Event and guard | To |
|---|---|---|
| Any non-terminal state except already paused | `pause_requested` | same phase, `PAUSED`; prior block reason retained |
| Same phase, `PAUSED` | `resume_requested` | prior user/provider block when retained, otherwise `QUEUED` |
| `QUEUED`, `RUNNING`, or `RECOVERING` | `provider_unavailable` | same phase, `BLOCKED_PROVIDER/provider_unavailable` |
| Same phase, `BLOCKED_PROVIDER` | `provider_restored` | same phase, `RECOVERING` |
| `QUEUED`, `RUNNING`, `BLOCKED_PROVIDER`, or `BLOCKED_USER/unrecoverable_failure` | `recovery_started`, non-empty reason | same phase, `RECOVERING` |
| Same phase, `RECOVERING` | `recovery_succeeded`, boundary reconciled | same phase, `QUEUED` |
| Same phase, `RECOVERING` | `recovery_blocked`, non-empty reason | same phase, `BLOCKED_USER/unrecoverable_failure` |
| Matching cap block | `extra_round_approved`, matching gate | `BUILD/QUEUED` |
| Any non-terminal state | `cancel_requested` after quiescence | `DONE/TERMINAL/CANCELLED` |
| Any non-terminal state | `unrecoverable_failure` | `DONE/TERMINAL/FAILED` |

Pause/cancel orchestration quiesces provider handles and Crew tasks, aborts deterministic
verification, and releases the writer lease before active execution may continue or terminate.
Control commands and runner transitions share one per-run serialization chain. A control therefore
cannot observe the gap between a member transition and its Task enqueue, and exact revision CAS is
rechecked inside that chain before any terminal or paused tuple is persisted.

## Deterministic evidence guards

Reducer shape alone is not proof. Services enforce these boundaries before emitting events:

1. The run has one canonical retained worktree, expected branch, reachable full head, and required
   cleanliness.
2. Only `builder:primary` may hold the one writer lease.
3. Member submissions carry the exact run/member authority, attempt idempotency key, context
   revision, and workspace head.
4. Nuncio finalizes Builder intent against Git; a model-supplied head is insufficient.
5. Verify comes only from the Nuncio Tester, sandboxed at the frozen command/current head.
6. Review uses an intact complete base-to-current diff and typed current-head findings.
7. Any head change makes prior verify/review evidence stale.
8. Synthesis completion revalidates worktree, artifact integrity, Verify, Review, and Reviewer
   lineage.
9. A frozen unavailable provider/model blocks; no runtime chooses another binding.
10. Duplicate events, callbacks, results, attempts, and successor requests are idempotent or
    revision-conflicted, never double-applied.

## Durable events and projection

The reducer accepts this event vocabulary:

```text
run_created
workspace_prepared
plan_started
plan_accepted
clarification_required
clarification_resolved
builder_claimed
builder_completed
verify_started
verify_passed
verify_failed
reviewer_claimed
final_review_requested
final_reviewer_claimed
review_passed
changes_requested
foreman_claimed
synthesis_completed
pause_requested
resume_requested
provider_unavailable
provider_restored
recovery_started
recovery_succeeded
recovery_blocked
extra_round_approved
cancel_requested
unrecoverable_failure
```

Each persisted event carries run id, monotonic sequence, idempotency key, actor, context revision,
workspace head, and timestamp. `CrewRunsRepository.replay(runId)` must reproduce the stored
projection; recovery blocks if it does not.

## Recovery authority

On daemon bootstrap, each non-terminal run is reconciled from durable facts:

1. Replay and compare the event projection.
2. Validate canonical path, branch, reachability, exact full head, and required cleanliness.
3. If Builder settlement was interrupted, idempotently finish intent → checkpoint → finalized
   result before boundary comparison; a clean checkpoint descendant is accepted only through this
   correlated finalizer, never as a new baseline.
4. Release the correlated stale Builder lease after result persistence and before reacquisition.
5. Resume the current provider Session when it can resume outside process memory; otherwise create
   a linked member incarnation with the same frozen binding.
6. Queue the preserved phase after `recovery_succeeded`.
7. Raise one `crew-blocked` Attention item on irreconcilable state.

An interrupted Verify is aborted during shutdown, excluded from failed-gate projection, and may run
again only after exact current-head and clean-boundary proof. A dirty Build worktree is retained only
through the explicit recovery marker so the same Builder can reconcile it. A crash-created
deterministic worktree must equal the frozen base SHA. Recovery never rewrites unexpected Git state.

## Immutable terminal runs and successors

`DONE/TERMINAL` rejects all reducer events. A change request:

1. identifies the terminal prior run and exact expected revision/base head;
2. requires its retained worktree to remain canonical, clean, reachable, and at that head;
3. creates one new `CrewRun` with `priorRunId`, a new immutable profile snapshot, and prior
   bounded context/evidence;
4. adopts the retained worktree as a new base while leaving all new gates invalid;
5. may resume compatible healthy Foreman/Builder Sessions;
6. creates new linked members when compatibility or resumability fails;
7. never mutates prior events, gates, results, artifacts, snapshot, or outcome.

Crew completion is local. The state machine exposes no forge, release, or deployment phase and no
route that converts failed evidence into success.
