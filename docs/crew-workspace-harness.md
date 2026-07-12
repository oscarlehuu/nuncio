# Crew Workspace Harness

**Status:** proposed design baseline; not shipped.  
**Last updated:** 2026-07-10.  
**Decision companion:** [CrewRun authority boundary and state machine](crew-run-authority-and-state-machine.md).

## Purpose

Nuncio should support two execution modes:

- **Solo** runs one provider session selected by the user.
- **Crew** runs a provider-neutral workflow whose members may use different engines and models.

Crew mode makes Nuncio a **provider-neutral workspace and crew harness**. Nuncio owns the outer
loop: roles, task routing, shared workspace, context handoff, verification, review, recovery,
budgets, and human attention. Each provider still owns its inner model loop, tools, compaction,
and conversation runtime.

This keeps the design consistent with the product vision: Nuncio does not call raw model APIs or
replace Claude Agent SDK, Codex app-server, Cursor SDK, or Pi. It coordinates those runtimes on
the user's machine.

## Agreed product model

### Solo versus Crew

The new-task surface keeps the existing engine and model picker in Solo mode:

```text
Mode: Solo
Engine: Codex
Model: GPT-5.6 Sol
```

Crew mode replaces the per-run model picker with a saved crew profile:

```text
Mode: Crew
Profile: Oscar Quality Crew

Resolved team
Fable -> Sol -> Verify -> Opus
```

An advanced disclosure may allow a temporary run override. A run override never mutates the saved
profile.

### Preset versus profile

A **preset** is a Nuncio-supplied template describing intent, role requirements, workflow, and
policy defaults. It should prefer capabilities over hard-coded provider ids.

```yaml
id: quality
roles:
  foreman:
    requires: [reasoning, delegation, tool-calling]
  builder:
    requires: [coding, workspace-write]
  tester:
    requires: [command-execution]
  reviewer:
    requires: [code-review, read-only]
    independentFrom: builder
workflow: [plan, build, verify, review, complete]
```

A **profile** is a user's saved, validated binding of a preset to engines and models available on
their machine.

```yaml
id: oscar-quality
basedOn: quality
members:
  foreman: { provider: claude, model: claude-fable-5 }
  builder: { provider: codex, model: gpt-5.6-sol }
  reviewer: { provider: claude, model: claude-opus-4-8 }
policy:
  maxFixRounds: 2
  requireVerify: true
  requireReview: true
```

Provider adapters advertise capabilities and live models. Profile editing only offers compatible
bindings. A profile resolves to one of three states:

- **Ready:** all requested bindings and guarantees are available.
- **Adjusted:** a declared fallback is active and the change is visible.
- **Needs setup:** a required capability or independence guarantee cannot be met.

Provider changes must not happen silently. A model update within an explicitly allowed family may
be automatic; switching provider, dropping read-only enforcement, or losing reviewer independence
requires user confirmation or blocks a strict profile.

### Settings hierarchy

Configuration resolves in this order:

```text
run override
  > project override
  > saved crew profile
  > preset defaults
  > declared capability fallback
```

Settings are split by concern:

1. **Engines:** connection, availability, model catalog, permissions, and capabilities.
2. **Crew profiles:** role bindings, fallback policy, limits, and required gates.
3. **Projects:** default profile, verify command, workspace policy, and project-specific overrides.
4. **New task:** Solo or Crew, profile selection, resolved-team preview, and temporary overrides.

Every CrewRun stores an immutable resolved profile snapshot. Editing a profile affects new runs,
not work already in progress.

Crew profiles are different from the existing engine **PromptProfile**:

| Concept | Question it answers |
|---|---|
| Crew preset/profile | Which roles, engines, workflow, permissions, and gates make up the team? |
| PromptProfile | How does one provider/model receive briefs, facts, digests, and tool guidance? |

The Crew resolver chooses the member. PromptProfile renders that member's provider-native context.

### Provider direction

Crew orchestration does not require Pi. A direct Claude Agent SDK foreman can delegate to a direct
Codex app-server builder through Nuncio's provider-neutral tools and task layer. Pi may remain an
optional provider while direct Claude and Codex paths mature; deleting or deprecating Pi is a
separate product and ADR decision, not a requirement of Crew mode.

## Backend model

### Shared truth, not shared hidden context

Models cannot share hidden reasoning state or provider KV caches. They should not receive identical
full transcripts either. Nuncio owns a durable **CrewContext spine**, and each member receives a
small role-specific projection.

```text
                       CrewContext
        objective - decisions - artifacts - workspace
            verify - review - status - revisions
                          |
             +------------+------------+
             |            |            |
          Foreman       Builder      Reviewer
          projection    projection   projection
```

The conversation inside each provider remains private working memory. CrewContext is the shared
source of truth.

```ts
interface CrewContext {
  runId: string;
  revision: number;
  objective: string;
  constraints: string[];
  decisions: Decision[];
  workspace: WorkspaceRef;
  artifacts: ArtifactRef[];
  memberResults: MemberResult[];
  verify: VerifyResult | null;
  review: ReviewResult | null;
  openQuestions: string[];
}
```

Every published result records `basedOnRevision` and `workspaceHead`. A stale verify or review
result is automatically invalid when the workspace head changes.

### Role-specific context envelopes

A fresh member receives a bounded envelope, not the parent transcript:

```ts
interface ContextEnvelope {
  runId: string;
  contextRevision: number;
  role: CrewRole;
  goal: string;
  constraints: string[];
  relevantDecisions: Decision[];
  workspaceRef: WorkspaceRef;
  artifactRefs: ArtifactRef[];
  doneCriteria: string[];
  verifyCommand?: string;
  previousAttempt?: AttemptSummary;
}
```

Views differ by role:

| Role | Default context |
|---|---|
| Foreman | Objective, decisions, member status, bounded digests, open questions |
| Builder | Bounded goal, affected paths, current workspace, latest verify/review feedback |
| Tester | Acceptance criteria, changed paths, head SHA, verify command |
| Reviewer | Requirements, decisions, diff, verify evidence; never builder reasoning |

Agents escalate progressively through context tools:

```text
summary
  -> artifact metadata
  -> bounded artifact range/search
  -> compact events since seq
  -> raw transcript only as a last resort
```

The current `HandoffBrief`, project facts, compact event reader, and completion digest are the
starting primitives. Crew mode should consolidate them behind a CrewContext service rather than
introducing another parallel context system.

### Artifacts and failure packets

Complete command output is stored as a redacted artifact. A fixed line count is only a preview,
never a correctness boundary.

```ts
interface VerifyArtifact {
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  workspaceHead: string;
  fullLogRef: string;
  logHash: string;
  failingTests: string[];
  primaryErrors: ErrorExcerpt[];
}
```

The builder first receives a structured failure packet: failing cases, primary causal excerpts,
and the full-log reference. It can search or read further ranges on demand. Logs are redacted
before storage, scoped to the run/project, and deleted by retention policy.

Machine-verifiable fields such as branch, head SHA, diff, exit code, and check result are produced
by Nuncio. Model prose is supplementary and must not overwrite deterministic evidence.

### Member sessions

Session identity belongs to a logical member incarnation, not merely a model:

```text
CrewRun 123
  foreman:primary  -> Claude session F1
  builder:primary  -> Codex session B1
  reviewer:primary -> Claude session R1
  tester:runner    -> deterministic process; no model session required
```

The same builder session is reused for verify and review feedback rounds. A second parallel
builder gets a different member session even when it uses the same model.

```ts
interface CrewMemberSession {
  id: string;
  crewRunId: string;
  memberKey: string;
  provider: string;
  model: string;
  sessionId: string;
  providerThreadId: string | null;
  priorMemberSessionId: string | null;
  lifecycle: 'active' | 'idle-reusable' | 'dormant' | 'archived' | 'purged';
  lastSeenContextRevision: number;
  lastSeenWorkspaceHead: string;
  contextHealth: 'healthy' | 'compacted' | 'degraded';
  lastUsedAt: number;
}
```

For the same healthy member, Nuncio sends a context delta into the existing provider thread. A
fresh or degraded member gets a successor session linked by `priorMemberSessionId` and seeded from
a checkpoint plus artifact references.

Session memory is optimistic context; Git and CrewContext remain authoritative. Before a follow-up,
Nuncio compares `lastSeenWorkspaceHead` with the current head and reports any external delta.

### Workspace policy

MVP uses one CrewRun-owned worktree and one writer lease:

| Role | Workspace permission |
|---|---|
| Foreman | read/context/delegate |
| Builder | exclusive write lease |
| Tester | read plus allowlisted verify commands |
| Reviewer | read-only |

This avoids merge coordination during the first implementation. Any workspace change invalidates
verify/review evidence tied to an older head.

Parallel writers require isolated worktrees and an explicit integration stage; that belongs in
the later roadmap.

### Recovery and resume

Recovery has three independent layers:

1. **Client reconnect:** replay append-only events from the last `seq`; the daemon keeps working.
2. **Provider reconnect:** preserve the member attempt, reconnect/resume the provider thread, and
   reconcile the workspace before sending a recovery delta.
3. **Daemon/machine restart:** rebuild non-terminal CrewRuns from SQLite events, provider thread
   ids, context checkpoints, durable queues, artifacts, and worktrees.

Nuncio promises recovery from the latest durable boundary, not the exact middle of token generation
or an arbitrary external side effect.

```ts
type RecoveryDecision =
  | 'reconnect-live-turn'
  | 'resume-provider-thread'
  | 'resume-from-workspace'
  | 'create-successor-session'
  | 'needs-attention';
```

Each external side effect uses an operation journal and an idempotency/reconciliation strategy.
After a crash, an operation with `tool_start` but no durable result is `unknown`, not automatically
retried. Git pushes, PR creation, deploys, and other writes are queried before retry; irreconcilable
operations surface in Attention.

### Lifecycle and cleanup

Disposing a live provider handle is not deleting its durable thread. Resources have separate
retention:

- live subprocess/socket: dispose after the stage or an idle timeout;
- provider thread reference: retain while the member may be continued;
- CrewContext and event log: retain for audit and restart recovery;
- worktree/branch: retain through review and acceptance;
- artifacts/logs: retain by explicit policy;
- provider transcript: purge only through a provider-specific delete capability when requested.

A completed task followed by a user change request creates a successor run linked to the completed
run. It may reuse healthy Fable/Sol member sessions while keeping the previous run immutable and
auditable. If a provider thread is missing or unhealthy, the successor starts from the final
checkpoint and current Git state.

## MVP baseline

The first Crew implementation should deliberately stay narrow:

```text
Orchestrator: Nuncio deterministic workflow
Foreman:      configurable; Fable profile default
Builder:      configurable; Sol profile default
Tester:       deterministic verify command
Reviewer:     configurable, read-only

Workspace:    one shared CrewRun worktree
Writers:      one at a time
Context:      role envelope + progressive artifact reads
Feedback:     reuse the same builder member session
Completion:   green verify + no blocking review findings
Recovery:     provider thread, then context/workspace successor fallback
Publishing:   explicit user approval when enabled
```

MVP deliverables:

1. Solo/Crew mode and resolved profile snapshot.
2. Preset/profile/project resolution against live provider capabilities.
3. CrewTask, CrewRun, CrewMemberSession, context events, and artifact records.
4. Deterministic CrewRun reducer and transition guards.
5. Shared worktree with an exclusive writer lease.
6. Structured member result and verify/review contracts tied to head SHA.
7. `continueMember`, hibernate/restore, recovery scan, and successor-session fallback.
8. Full-log artifacts with bounded failure packets and progressive reads.
9. Crew UI showing stage, members, gates, attention, and recovery state.
10. Restart, stale-result, retry, context-budget, and side-effect idempotency tests.

MVP is a fixed guarded coding workflow, not a general DAG/workflow engine. Profiles may enable or
skip declared gates, but they do not define arbitrary nodes, transitions, or recursive delegation.

## Build later ("sau đó build thêm")

These are intentional extensions, not MVP dependencies:

1. **Parallel writers:** isolated member worktrees plus an integration/merge role.
2. **Dynamic role creation:** foreman-proposed specialists beyond roles declared by the profile.
3. **Provider-native nested agents:** optional inner fan-out inside Claude or Codex without making
   provider-specific lineage the shared Crew contract.
4. **Adaptive routing:** latency/cost/quality-aware role selection with visible fallback evidence.
5. **Semantic retrieval:** embeddings or RAG for large decision/document history after structured
   facts, refs, and lexical search prove insufficient.
6. **Advanced caching:** provider-specific cache keys/breakpoints and cache-read/write telemetry.
7. **Multiple reviewers:** security, correctness, UX, and docs lanes with a deterministic merge of
   findings.
8. **Distributed execution:** members running on different Nuncio machines through the existing
   hub model.
9. **Autonomous publishing:** policy-gated push, PR/MR creation, merge, deploy, and rollback.
10. **Learning and eval routing:** profile suggestions based on measured success, token use,
    latency, human intervention, and resume quality.
11. **Profile sharing:** import/export or marketplace packaging once the profile schema stabilizes.
12. **True cross-provider purge:** provider thread deletion, artifact lifecycle, and compliance
    audit across every adapter.

## Evaluation and success metrics

Crew complexity is justified only if it beats an appropriate Solo baseline. Evaluate representative
tasks in both modes:

```text
Solo Sol
versus
Fable foreman -> Sol builder -> Verify -> independent reviewer
```

Track:

- task and verify success rate;
- blocking defects found after the builder reports completion;
- automated fix/review rounds;
- human interventions and overrides;
- input/output and cached-token usage when providers report it;
- wall-clock time and queue wait;
- stale-result rejections and writer conflicts;
- recovery success after client disconnect, provider loss, and daemon termination;
- duplicated or unknown external side effects;
- context-envelope and artifact-read bytes per role.

The default profile should remain simple when Crew adds cost or latency without a material quality
gain. Evaluation is a product gate, not a post-launch analytics task.

## Current foundations and known gaps

Reusable foundations already present:

- provider-neutral `AgentProvider` and capability registry;
- persistent session/provider thread ids;
- append-only event log and cursor replay;
- durable task and steer queues;
- handoff brief and project facts;
- budgeted cross-session reads and completion digests;
- verify feedback loop rebuilt from durable events;
- worktrees, diffs, forge actions, and Attention.

Important gaps before Crew can claim restart-safe end-to-end behavior:

- a `RUNNING` task at daemon boot currently becomes terminal `FAILED: daemon_restart`; Crew needs
  `interrupted -> recovering` reconciliation;
- task cleanup policy is persisted, but reviewed-task worktree/provider transcript cleanup is not a
  complete lifecycle service;
- task retry currently clones a fresh task/session instead of continuing a healthy member session;
- completion digest still falls back to assistant prose instead of a required structured member
  result;
- no CrewRun-owned workspace/write lease or head-bound verify/review invalidation exists yet;
- no operation journal protects arbitrary external side effects from crash-time duplication.

## Non-goals

- Do not build a raw model API harness inside Nuncio.
- Do not copy full transcripts between providers by default.
- Do not treat model claims as proof that tests, reviews, or publication succeeded.
- Do not hard-code Fable, Sol, Claude, Codex, or Pi in the shared session/task/UI layers.
- Do not permit multiple writers in one worktree concurrently.
- Do not build arbitrary profile-defined DAGs in the MVP.
- Do not promise exactly-once execution for arbitrary tools; use idempotency and reconciliation.

## Open product decisions

The following remain user decisions and are not locked by this document:

1. Whether a normal plan proceeds automatically or needs approval for selected profiles.
2. Whether every successful reviewed run requires a final human acceptance step.
3. Which finding severities block completion and how many fix/review rounds are allowed.
4. How long completed member threads, logs, and worktrees remain resumable.
5. Whether Pi remains visible as an optional provider, becomes legacy-hidden, or is removed.
6. Which authentication paths are supported for distributed/self-hosted Claude and Codex usage.
7. Whether a user change request creates a new top-level task or a successor run under the same
   task; the companion state-machine draft recommends a successor run.
