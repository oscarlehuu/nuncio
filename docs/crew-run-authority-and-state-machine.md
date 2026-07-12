# CrewRun Authority Boundary and State Machine

**Status:** decision draft; not an ADR and not shipped.  
**Last updated:** 2026-07-10.  
**Parent design:** [Crew Workspace Harness](crew-workspace-harness.md).

## Why this decision is load-bearing

A foreman model is useful because it can understand an ambiguous goal, decompose work, and react to
member results. It must not become the database, scheduler, permission system, or proof of
completion.

The authority boundary answers:

- who may change scope;
- who chooses a role versus an engine;
- who is allowed to write;
- who decides whether verify/review evidence is valid;
- who may retry, publish, pause, cancel, or mark a run complete;
- what survives a model, network, daemon, or machine failure.

The proposed rule is:

> The foreman decides what work to propose. Nuncio decides what is allowed, what evidence is valid,
> and when the workflow may transition. The user owns business intent and irreversible authority.

## Actors

### User

Owns the objective, scope changes, profile selection, business decisions, destructive approval,
exception overrides, cancellation, and acceptance of unresolved risk.

### Nuncio orchestrator

Owns durable state, profile resolution, role eligibility, permissions, queues, writer leases,
budgets, transition guards, verification execution, review validity, retries, recovery,
idempotency, attention, and completion.

### Foreman

Interprets the goal, proposes a plan, decomposes work, requests declared roles, authors bounded
handoffs, reacts to structured results, and recommends the next action. It does not mutate CrewRun
state directly.

### Builder

Executes a bounded implementation goal under an exclusive workspace write lease and returns a
structured member result. It does not approve its own verification or review.

### Tester

The default tester is deterministic command execution owned by Nuncio. An optional test-analysis
model may interpret failures or propose additional tests, but its prose does not set the verify
gate.

### Reviewer

Reads requirements, decisions, diff, and verify evidence; returns structured findings tied to a
workspace head. It is read-only in MVP.

### Publisher

Executes explicitly allowed external side effects after required gates and approval. It may be a
Nuncio service rather than a model member.

## Authority matrix

| Decision/action | User | Nuncio | Foreman/member |
|---|---|---|---|
| Set or change the business objective | Authoritative | Persist and version | May identify ambiguity only |
| Select a saved crew profile | Authoritative | Resolve and validate | No |
| Decompose work | May steer/override | Validate against policy | Foreman proposes |
| Select a role | May override | Enforce declared roles/capabilities | Foreman requests |
| Select provider/model | Configure profile/override | Resolve binding/fallback | No direct provider choice in MVP |
| Write the worktree | May intervene explicitly | Grant one writer lease | Current builder only |
| Run verification | May request | Execute and record | May request; cannot self-certify |
| Mark verify passed | No prose override | Exit code + head-bound evidence | No |
| Mark review passed | May accept an exception | Validate verdict, blockers, and head | Reviewer reports only |
| Retry within configured cap | May steer | Enforce cap and resume policy | Foreman recommends |
| Exceed cap/change provider | Approve | Surface in Attention | May request |
| Publish/merge/deploy | Approve per policy | Execute/journal/reconcile | May propose |
| Mark run completed | No direct database write | Sole authority after guards | May recommend only |
| Pause/cancel/archive/purge | Authoritative | Execute safely | May request pause for a blocker |

## Proposed aggregate model

### CrewTask and CrewRun

Separate the stable user intention from an immutable execution revision:

```text
CrewTask "Add authentication"
  Run 1 -> completed at head H1
  User change request
  Run 2 -> priorRunId=Run 1, starts from H1
```

- **CrewTask:** stable user-facing task/thread, objective history, and linked runs.
- **CrewRun:** one profile snapshot, workspace lineage, execution attempt, and terminal outcome.

A completed CrewRun is never reopened. A user change creates a successor CrewRun, but the successor
may reuse healthy foreman/builder provider sessions and the same branch/worktree under an explicit
continuation record. This preserves both smart continuity and immutable audit history.

### State is a tuple, not one exploding enum

Workflow progress and operational interruption are orthogonal. Store them separately:

```ts
type CrewRunPhase =
  | 'PLAN'
  | 'BUILD'
  | 'VERIFY'
  | 'REVIEW'
  | 'SYNTHESIZE'
  | 'APPROVAL'
  | 'PUBLISH'
  | 'DONE';

type CrewRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'BLOCKED_USER'
  | 'BLOCKED_PROVIDER'
  | 'PAUSED'
  | 'RECOVERING'
  | 'TERMINAL';

type CrewRunOutcome =
  | null
  | 'SUCCEEDED'
  | 'SUCCEEDED_WITH_EXCEPTIONS'
  | 'FAILED'
  | 'CANCELLED';
```

The exact state is `(phase, status, outcome)`. Examples:

```text
(BUILD, RUNNING, null)          Sol is implementing
(VERIFY, QUEUED, null)          verify is ready to run
(REVIEW, BLOCKED_PROVIDER, null) reviewer provider is unavailable
(SYNTHESIZE, RUNNING, null)     foreman is preparing the final result
(APPROVAL, BLOCKED_USER, null)  publish needs user approval
(DONE, TERMINAL, SUCCEEDED)     immutable successful run
```

This avoids separate `PAUSED_BUILDING`, `PAUSED_REVIEWING`, `RECOVERING_VERIFYING`, and similar
state explosion. Phase is preserved while status changes.

Legal-state invariants keep the tuple from becoming a set of arbitrary combinations:

1. `phase === DONE` if and only if `status === TERMINAL`.
2. A terminal state has a non-null outcome; every non-terminal state has `outcome === null`.
3. `QUEUED` and `RUNNING` are valid only for executable phases. `APPROVAL` normally waits in
   `BLOCKED_USER`; `DONE` is never queued or running.
4. `PAUSED`, `BLOCKED_PROVIDER`, and `RECOVERING` retain the current phase. They do not count as
   phase progress.
5. `BLOCKED_USER` records a typed reason such as `clarification`, `round_cap`, or `approval`; only
   events valid for that reason may unblock it.
6. A gate exception never rewrites its evidence. A failed command remains failed and a waived
   review finding remains present. The final outcome becomes `SUCCEEDED_WITH_EXCEPTIONS`.

## Exact happy path

```text
(PLAN, QUEUED)
  -> (PLAN, RUNNING)
  -> (BUILD, QUEUED)
  -> (BUILD, RUNNING)
  -> (VERIFY, QUEUED)
  -> (VERIFY, RUNNING)
  -> (REVIEW, QUEUED)
  -> (REVIEW, RUNNING)
  -> (SYNTHESIZE, QUEUED)
  -> (SYNTHESIZE, RUNNING)
  -> (APPROVAL, BLOCKED_USER)  [only when profile/publish policy requires]
  -> (PUBLISH, QUEUED)
  -> (PUBLISH, RUNNING)
  -> (DONE, TERMINAL, SUCCEEDED)
```

If verify or review is disabled by the profile, the reducer skips that declared gate. Synthesis is
not skipped: it produces the bounded final report and recommended next action. If no approval or
publish stage is configured, successful synthesis may transition directly to terminal success.

## Transition table

| From | Event | Guard | To |
|---|---|---|---|
| `PLAN/QUEUED` | `plan_started` | foreman binding ready | `PLAN/RUNNING` |
| `PLAN/RUNNING` | `plan_accepted` | plan uses declared roles and policy | `BUILD/QUEUED` |
| `PLAN/RUNNING` | `clarification_required` | material user decision missing | `PLAN/BLOCKED_USER` |
| `PLAN/BLOCKED_USER` | `clarification_resolved` | objective/context revision recorded | `PLAN/QUEUED` |
| `BUILD/QUEUED` | `builder_claimed` | writer lease acquired | `BUILD/RUNNING` |
| `BUILD/RUNNING` | `builder_completed` | structured result + reachable head | next enabled gate: `VERIFY`, `REVIEW`, or `SYNTHESIZE` `/QUEUED` |
| `VERIFY/QUEUED` | `verify_started` | command resolved for current head | `VERIFY/RUNNING` |
| `VERIFY/RUNNING` | `verify_passed` | exit 0; result head equals current head | `REVIEW/QUEUED` or `SYNTHESIZE/QUEUED` |
| `VERIFY/RUNNING` | `verify_failed` | fix round remains | `BUILD/QUEUED` |
| `VERIFY/RUNNING` | `verify_failed` | cap reached/repeated identical failure | `VERIFY/BLOCKED_USER` |
| `VERIFY/BLOCKED_USER` | `extra_round_approved` | typed override recorded | `BUILD/QUEUED` |
| `VERIFY/BLOCKED_USER` | `gate_exception_accepted` | risk accepted; evidence retained | `SYNTHESIZE/QUEUED` with exception |
| `REVIEW/QUEUED` | `reviewer_claimed` | reviewer ready; read-only enforced | `REVIEW/RUNNING` |
| `REVIEW/RUNNING` | `review_passed` | result head current; no blocker | `SYNTHESIZE/QUEUED` |
| `REVIEW/RUNNING` | `changes_requested` | fix/review round remains | `BUILD/QUEUED` |
| `REVIEW/RUNNING` | `changes_requested` | cap reached | `REVIEW/BLOCKED_USER` |
| `REVIEW/BLOCKED_USER` | `extra_round_approved` | typed override recorded | `BUILD/QUEUED` |
| `REVIEW/BLOCKED_USER` | `gate_exception_accepted` | findings retained and risk accepted | `SYNTHESIZE/QUEUED` with exception |
| `SYNTHESIZE/QUEUED` | `foreman_claimed` | current gates and context available | `SYNTHESIZE/RUNNING` |
| `SYNTHESIZE/RUNNING` | `synthesis_completed` | bounded structured final result | `APPROVAL/BLOCKED_USER` or terminal success/with-exceptions |
| `APPROVAL/BLOCKED_USER` | `publish_approved` | verify/review still current | `PUBLISH/QUEUED` |
| `APPROVAL/BLOCKED_USER` | `accepted_without_publish` | user accepts local result | terminal success |
| `PUBLISH/QUEUED` | `publisher_claimed` | operation journal prepared | `PUBLISH/RUNNING` |
| `PUBLISH/RUNNING` | `publish_succeeded` | external refs read back | terminal success/with-exceptions |
| any non-terminal | `pause_requested` | no uninterruptible operation | same phase, `PAUSED` |
| same phase, `PAUSED` | `resume_requested` | dependencies ready | same phase, `QUEUED` |
| any active state | `provider_unavailable` | transient/recoverable | same phase, `BLOCKED_PROVIDER` |
| same phase, `BLOCKED_PROVIDER` | `provider_restored` | binding/thread usable | same phase, `RECOVERING` |
| same phase, `RECOVERING` | `recovery_succeeded` | workspace/context reconciled | same phase, `QUEUED` |
| any non-terminal | `cancel_requested` | operation reconciled | `DONE/TERMINAL/CANCELLED` |
| any non-terminal | `unrecoverable_failure` | fallback exhausted | `DONE/TERMINAL/FAILED` |

`BUILD` covers both initial implementation and later fixes. Store `buildRound`, `verifyRound`,
`reviewRound`, and `feedbackSource`; a separate `FIXING` phase is unnecessary.

The `next enabled gate` is derived only from the immutable resolved profile snapshot. Skipping a
disabled gate emits `gate_skipped` for audit; a model cannot choose to skip it.

## Transition guards

The reducer rejects a transition unless all applicable invariants hold:

1. Only one writer lease exists for the CrewRun worktree.
2. A member result includes `basedOnContextRevision` and `workspaceHead`.
3. Build completion references a reachable current head and a structured result.
4. Verify pass comes from Nuncio-owned command execution and matches the current head.
5. Review pass matches the current head and contains no blocking finding.
6. Any workspace-head change invalidates older verify and review gates.
7. Retry/review/build rounds stay within the immutable profile snapshot.
8. Provider/model fallback follows the profile; provider switches do not happen silently.
9. Publish requires current gates, permission policy, and any configured user approval.
10. Every external write has an operation id and reconciliation strategy.
11. Event application is idempotent; duplicate callbacks cannot advance the run twice.
12. Terminal CrewRuns never transition again.

## Durable events

The aggregate state is projected from append-only events so restart produces the same answer as the
live path:

```text
crew_run_created
profile_resolved
plan_started
plan_proposed
plan_accepted
clarification_required
clarification_resolved
member_started
member_completed
workspace_advanced
verify_started
verify_completed
review_started
review_completed
gate_skipped
extra_round_approved
gate_exception_accepted
synthesis_started
synthesis_completed
approval_requested
approval_resolved
publish_started
publish_completed
run_paused
run_resumed
provider_blocked
recovery_started
recovery_completed
run_completed
run_failed
run_cancelled
```

Every event carries an idempotency key, run revision, actor, timestamp, context revision, and
workspace head when relevant.

## Recovery semantics

A stale `RUNNING` member lease after daemon boot does not make the CrewRun terminal. It moves the
same phase to `RECOVERING`. The recovery coordinator selects:

```text
reconnect live provider turn
  -> resume provider thread
  -> resume from workspace with a successor session
  -> create successor from context checkpoint and branch
  -> block for user attention
```

Unknown side-effect outcomes are reconciled before a retry. A tool start with no durable completion
is not proof that the operation failed.

## User changes after completion

A user change request does not mutate the terminal run:

1. append the change request to the CrewTask;
2. create a successor CrewRun with `priorRunId` and a new profile/context snapshot revision;
3. retain the prior final head as the new base;
4. invalidate prior verify/review gates for the successor;
5. reuse healthy member provider threads only after workspace and context reconciliation;
6. otherwise create successor member sessions from the checkpoint.

The old provider session explains **why** the previous implementation exists; Git explains **what**
currently exists. Smart continuation uses both.

## Proposed MVP defaults

These are recommendations for discussion, not locked decisions:

- Plans auto-proceed when they stay within the selected profile and contain no material open
  question.
- The foreman requests declared roles; Nuncio resolves provider/model.
- One shared worktree and one builder write lease.
- Tester is deterministic and read-only by default.
- Reviewer is read-only; `blocker` findings block, warnings remain visible.
- A bounded number of automated verify/fix and review/fix rounds; cap exhaustion blocks for user.
- A user may explicitly accept a gate exception, but Nuncio retains the failed evidence and marks
  the outcome `SUCCEEDED_WITH_EXCEPTIONS`; it never relabels the gate as passed.
- Publishing and destructive external writes require explicit approval.
- Completed runs are immutable; user changes create successor runs.
- Healthy member sessions are reused across rounds and successor runs when safe.
- Nuncio alone marks a run complete after checking current evidence.

## Discussion checklist

The decisions to settle with the user before converting this draft into an ADR are:

1. **Plan approval:** auto-proceed inside profile, always approve, or profile-specific?
2. **Completion approval:** does green verify + clean review finish automatically, or wait for user?
3. **Gate exceptions:** which review severities block, may deterministic verify failure be accepted,
   and may exception-bearing runs publish?
4. **Round caps:** one shared cap or separate verify/review caps?
5. **Reviewer freshness:** reuse reviewer for incremental rounds, fresh final reviewer, or profile
   choice?
6. **Tester writes:** remain read-only, or may a test specialist add tests under a writer lease?
7. **Provider fallback:** when may Nuncio adapt automatically versus block for confirmation?
8. **Publishing:** local completion only in MVP, or include approval-gated PR/MR creation?
9. **Continuation:** successor CrewRun under one CrewTask (recommended) or reopen the same run?
10. **Retention:** how long should provider threads, artifacts, and worktrees remain resumable?
