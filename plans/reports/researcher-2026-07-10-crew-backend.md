# Crew backend MVP research

**Status:** research complete; no production code changed.
**Scope:** smallest production-ready backend slice consistent with the proposed Crew design.

## Recommendation

Build Crew as a **new event-sourced aggregate above existing tasks and sessions**:

```text
CrewTask -> immutable CrewRun -> queued member attempts -> existing Session/provider thread
                    |                    |
                    +-> Crew events      +-> same session reused for feedback
                    +-> one worktree
                    +-> verify/review evidence bound to committed HEAD
```

- Keep `sessions.status` unchanged; Crew owns its separate `(phase, status, outcome)` reducer. This preserves the shipped three-layer session FSM and avoids an exploding session enum (`docs/architecture-decisions.md:35-45`; `docs/crew-run-authority-and-state-machine.md:106-163`).
- Reuse `TasksService` as the low-level FIFO/concurrency pump, but treat each row as a **member attempt**, not as CrewRun truth. It already claims atomically, enforces concurrency, links a session, and notifies settlement consumers (`apps/server/src/tasks/tasks.repository.ts:102-141`; `apps/server/src/tasks/tasks.service.ts:438-472`; `apps/server/src/tasks/tasks.service.ts:496-553`).
- Reuse existing provider sessions for member continuity. Provider thread ids are durable on sessions (`apps/server/src/sessions/domain/sessions.types.ts:100-138`; `apps/server/src/sessions/persistence/sessions.repository.ts:268-301`) and Pi/Codex/Claude advertise restart resumability through the generic contract (`apps/server/src/agents/agents.types.ts:111-116`).
- Make Nuncio, not a model, the transition authority. Models submit structured plan/member/review/synthesis results through Nuncio runtime tools; the reducer validates them before advancing, matching the proposed authority matrix (`docs/crew-run-authority-and-state-machine.md:22-25`; `docs/crew-run-authority-and-state-machine.md:67-84`).

## Locked constraints and conflicts

No proposed Crew decision inherently conflicts with a locked ADR if implemented as the outer orchestration layer.

| Constraint | Consequence for Crew |
|---|---|
| One local Bun daemon + SQLite (`docs/architecture-decisions.md:15-33`) | No Redis, worker service, hosted coordinator, or raw model API. |
| Durable conversation / disposable loop / strict session FSM (`docs/architecture-decisions.md:35-45`) | Crew state is separate; member sessions remain ordinary sessions. |
| Generic-first provider contract (`docs/architecture-decisions.md:47-61`) | Role permissions become a provider-neutral runtime policy/capability, never `provider === 'codex'` in Crew. |
| SQLite + guarded manual migration (`docs/architecture-decisions.md:75-84`) | Add `CREATE TABLE IF NOT EXISTS`; use guarded `ALTER TABLE` only for existing tables; positional `?` parameters. |
| Seq-cursor replay (`docs/architecture-decisions.md:86-94`) | Crew gets its own append-only `crew_events(run_id, seq)` replay API; do not stuff aggregate events into one member's session log. |
| TDD-first (`docs/architecture-decisions.md:105-115`) | Pure reducer/repository tests precede runner code; restart tests are release blockers. |

Potential violations to reject:

- Adding `PLAN`, `VERIFY`, or `REVIEW` to `SessionStatus` would conflict with ADR-003; the shipped session transition table is intentionally small (`apps/server/src/sessions/domain/sessions.fsm.ts:4-20`).
- Hard-coding Fable/Sol/Opus in runner branches would conflict with ADR-004 and the Crew non-goal (`docs/crew-workspace-harness.md:455-463`). They may be suggested profile bindings only.
- Reusing `events` under a foreman session as Crew truth would make recovery depend on one model thread and violate the proposed shared CrewContext spine (`docs/crew-workspace-harness.md:133-172`).
- Current provider permissions are global, not per member: Codex resolves only global `full-access` versus `approval-required` (`apps/server/src/agents/providers/codex-agent.provider.ts:653-676`), and Claude reads one global permission mode (`apps/server/src/agents/providers/claude-agent.provider.ts:441-460`; `apps/server/src/agents/providers/claude-agent.provider.ts:773-778`). Crew cannot claim an enforced read-only reviewer until this becomes per-session/provider-neutral.

## Reusable primitives

| Existing primitive | Reuse | Required Crew delta |
|---|---|---|
| `AgentProvider` + registry/model catalog (`apps/server/src/agents/agents.types.ts:22-29`; `apps/server/src/agents/agents.registry.ts:41-79`; `apps/server/src/models/models.service.ts:9-20`) | Resolve live provider/model bindings and resume threads. | Add supported runtime policies (at minimum read-only/workspace-write + network flag) and pass policy through `AgentRunContext`. |
| Base provider lifecycle (`apps/server/src/agents/agents.base-provider.ts:220-282`) | Ordinary member turn events and `RUNNING -> IDLE/ERROR`. | No Crew transitions in providers. |
| Task queue (`apps/server/src/tasks/tasks.types.ts:4-12`; `apps/server/src/tasks/tasks.repository.ts:102-141`) | Durable member-attempt scheduling and global concurrency. | Add Crew correlation and an existing-session continuation mode. |
| Session lineage/runtime state (`apps/server/src/sessions/domain/sessions.types.ts:100-138`) | One logical member incarnation maps to one normal session. | Persist generic `verify_owner` and `runtime_policy_json`; Crew-member table owns role/run lineage. |
| Restart reconciliation (`apps/server/src/sessions/sessions.service.ts:1728-1767`) | A crashed member session becomes honest `IDLE`, preserving resumable thread id. | Crew maps its interrupted task attempt to `RECOVERING`; it does not mark the run failed. |
| Durable steer queue (`apps/server/src/db/database.service.ts:442-469`) | Existing-session feedback survives when a provider is still running. | Use Crew task continuation for stage work; do not create a second competing queue. |
| Verify command resolver/runner (`apps/server/src/sessions/session-verifier.ts:4-40`; `apps/server/src/sessions/session-verifier.ts:45-80`) | Command resolution, timeout, exit status. | Extract reusable verifier; capture full redacted artifact + hash + full HEAD. Disable session-owned auto-verify for Crew members. |
| Verify retry fold (`apps/server/src/sessions/verify-feedback.ts:42-117`; `apps/server/src/sessions/verify-feedback.ts:124-149`) | Pattern for restart-safe event folding, repeated-failure detection, round caps. | Port concepts to Crew events; do not run the Solo auto-steer loop in parallel. |
| Git worktree (`apps/server/src/git/git.service.ts:301-327`) | Create exactly one `nuncio/<run>-<slug>` worktree for a CrewRun. | Add full HEAD/clean/reachability helpers and durable single-writer lease. |
| Workspace snapshot (`apps/server/src/orchestration/workspace-snapshot.ts:81-108`) | Brief/digest preview. | It uses short SHA and tolerates dirty state; Crew gates need full SHA and a clean committed boundary. |
| Handoff brief + compact event read (`apps/server/src/orchestration/handoff-brief.types.ts:3-26`; `apps/server/src/context/events-compactor.ts:74-126`) | Seed role-specific envelopes and progressive reads. | Extend to Crew context revision, member key, artifact refs, done criteria, and previous attempt. Never copy full transcripts by default. |
| Completion digest (`apps/server/src/orchestration/outcome-digest.builder.ts:127-154`) | UI-friendly preview only. | It falls back to assistant prose; Crew completion requires a structured submitted result. |
| Attention queue (`apps/server/src/attention/attention.types.ts:46-80`; `apps/server/src/attention/attention.service.ts:47-94`) | Durable deduped user escalation. | Add one `crew-blocked` kind with typed reason payload and reconcile it from CrewRun state. Resolving an Attention row alone must not bypass a gate. |
| Project defaults (`apps/server/src/projects/project-defaults-resolver.ts:13-18`; `apps/server/src/projects/project-defaults-resolver.ts:36-98`) | Existing project-over-global precedence. | Add soft `default_crew_profile_id`; run override > project > saved profile > preset. |
| Runtime tools (`apps/server/src/agents/tools/agent-runtime-tools.types.ts:13-23`; `apps/server/src/agents/tools/agent-tool-registry.ts:31-52`) | Provider-neutral structured submissions and artifact range reads. | Scope tools by Crew member role and run; re-check permissions on every call. |

## Concrete MVP cut

Ship one fixed guarded coding workflow:

1. `PLAN` — foreman submits a structured plan limited to declared roles.
2. `BUILD` — builder owns the one durable writer lease and submits a structured result.
3. `VERIFY` — Nuncio runs the configured command, stores a full redacted log artifact, and binds evidence to current committed HEAD.
4. `REVIEW` — independent read-only reviewer submits structured findings; only `blocker` prevents progress in v1.
5. Failed verify or blocking review returns to the **same builder session** while the shared `maxFixRounds` budget remains.
6. `SYNTHESIZE` — same foreman session emits a bounded structured final report.
7. Nuncio alone transitions to `DONE/TERMINAL/SUCCEEDED` after rechecking current HEAD and gates.

Production invariant missing from the draft: **every BUILD boundary must be a clean committed Git HEAD**. Otherwise edits can change while `HEAD` stays constant, making head-bound verify/review invalidation unsound. Reject `builder_completed` while `git status --porcelain` is non-empty.

Explicit MVP cuts:

- No arbitrary DAG/profile-defined nodes; one built-in Quality preset shape.
- No dynamic roles, recursive delegation, provider-native nested-agent lineage, or parallel writers.
- No automatic cross-provider fallback. Missing provider/model/policy => profile `Needs setup`; never silently weaken read-only or independence.
- No `APPROVAL`/`PUBLISH`, push, PR/MR, merge, deploy, or operation journal in v1. All member runtime policies disable network; publishing follows later with journaling.
- No gate exceptions and no reachable `SUCCEEDED_WITH_EXCEPTIONS` path in v1. User can approve one extra round, cancel, or create a successor run.
- No automatic cleanup/purge/retention timer. Retain worktree, member threads, Crew events, and artifacts; add explicit lifecycle only after policy is decided.
- No distributed/hub Crew, cost/quality adaptive routing, semantic retrieval, advanced caching, profile marketplace, or multiple reviewers.
- No Crew-specific WS protocol initially. Member transcripts keep the existing WS relay; Crew detail replays `GET .../events?since=` and may poll while visible. A later live channel must be additive/versioned, preserving the frozen session contract (`docs/ws-relay-contract.md:1-10`).

## Durable model and migration

Add new tables in `DatabaseService.migrate()` with `CREATE TABLE IF NOT EXISTS`; do not introduce a migration framework (`apps/server/src/db/database.service.ts:97-121`; `apps/server/src/db/database.service.ts:376-431`).

| Table | Minimum fields / invariant |
|---|---|
| `crew_profiles` | `id`, `name`, `preset_id`, `definition_json`, timestamps. Mutable saved binding; never referenced as live truth after run creation. |
| `crew_tasks` | `id`, `objective`, `project_path`, timestamps. Stable user intention. |
| `crew_runs` | `id`, `task_id`, `prior_run_id`, `phase`, `status`, `outcome`, `blocked_reason`, `profile_snapshot_json`, `context_json`, `context_revision`, `revision`, project/worktree/branch/full `workspace_head`, round counters, timestamps. Projection/cache of events. |
| `crew_events` | `run_id`, `seq`, `type`, `payload_json`, `idempotency_key`, actor, run/context revision, workspace head, timestamp. Unique `(run_id, seq)` and `(run_id, idempotency_key)`. |
| `crew_member_sessions` | `id`, `run_id`, `member_key`, `provider`, `model`, `session_id`, `prior_member_session_id`, lifecycle/context-health fields, last context revision/head/use time. One current incarnation per `(run_id, member_key)`. |
| `crew_member_results` | immutable structured submissions keyed by member session + attempt/phase; includes context revision and full HEAD. |
| `crew_artifacts` | `id`, `run_id`, kind, relative storage path, SHA-256, byte count, metadata JSON, retention state, timestamp. Bytes live under `<dataDir>/crew-artifacts/<runId>/`, not SQLite. |
| `crew_writer_leases` | `run_id` primary key, member session/task/token, acquired timestamp, starting HEAD. DB uniqueness enforces one writer. |

Guarded additions to existing tables:

- `sessions.verify_owner TEXT NOT NULL DEFAULT 'session'` and `sessions.runtime_policy_json TEXT`; Solo behavior remains byte-compatible.
- `tasks.crew_run_id`, `crew_member_key`, `crew_phase`, `execution_kind`; permit internal create with a pre-linked `session_id` for continuation.
- `projects.default_crew_profile_id`; soft reference, consistent with existing project-path soft references (`apps/server/src/db/database.service.ts:238-254`).

Transition application must be one SQLite transaction:

1. Load projection at expected `revision`.
2. Pure-reduce the typed event and validate invariants.
3. Insert event at `seq = revision + 1` with unique idempotency key.
4. CAS-update `crew_runs ... WHERE revision = ?`.
5. Commit, then enqueue/notify outside the transaction.

Duplicate idempotency keys return the current projection without advancing twice. Boot replays all non-terminal runs and repairs/flags any projection mismatch; MVP volume is small enough to avoid checkpoints.

## API contract

Suggested additive REST surface:

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/crew/presets` | Built-in fixed workflow metadata and required technical capabilities. |
| `GET/POST` | `/api/crew/profiles` | List/create saved role bindings + gate policy. Creation validates live provider/model catalog and independence. |
| `GET/PATCH/DELETE` | `/api/crew/profiles/:id` | Read/edit/delete future-run config; active/completed runs retain immutable snapshot. |
| `POST` | `/api/crew/profiles/:id/resolve` | `{ projectPath?, override? } -> { state: ready|needs_setup, snapshot?, issues[] }`. No silent provider fallback in v1. |
| `POST` | `/api/crew/tasks` | `{ objective, projectPath, baseBranch?, profileId, override? } -> { task, run }`; atomically records task/run/profile snapshot before background start. |
| `GET` | `/api/crew/tasks/:id` | Stable task + ordered immutable runs. |
| `POST` | `/api/crew/tasks/:id/runs` | `{ changeRequest, expectedBaseHead, profileId? }`; creates successor run, never reopens terminal prior run. |
| `GET` | `/api/crew-runs?status=&projectPath=` | Compact run list. |
| `GET` | `/api/crew-runs/:id` | Projection, resolved profile, worktree, members, current gates, blockers, artifact metadata. |
| `GET` | `/api/crew-runs/:id/events?since=&limit=` | Ordered durable events with `seq > since`. |
| `POST` | `/api/crew-runs/:id/pause` | Typed `pause_requested`; 409 during a non-interruptible boundary. |
| `POST` | `/api/crew-runs/:id/resume` | `PAUSED/BLOCKED_PROVIDER -> RECOVERING/QUEUED` after dependency check. |
| `POST` | `/api/crew-runs/:id/cancel` | Reconcile active attempt, release lease, terminal `CANCELLED`; idempotent. |
| `POST` | `/api/crew-runs/:id/clarification` | Resolve typed pending clarification with expected run revision. |
| `POST` | `/api/crew-runs/:id/extra-round` | Founder-approved one-round budget extension with expected revision. |
| `GET` | `/api/crew-runs/:id/artifacts/:artifactId?offset=&limit=` | Run-scoped bounded artifact range; never accepts a filesystem path. |

Every command body includes `expectedRevision`; stale UI actions return `409` with current projection. No public endpoint accepts raw event names or directly sets phase/status/outcome.

## Exact implementation surface

New backend files (focused, under ~200 lines where practical):

```text
apps/server/src/crew/
  crew.module.ts
  crew.persistence.module.ts
  api/crew.controller.ts
  domain/crew.types.ts
  domain/crew-run.reducer.ts
  domain/crew-results.ts
  persistence/crew-profiles.repository.ts
  persistence/crew-tasks.repository.ts
  persistence/crew-runs.repository.ts
  persistence/crew-events.repository.ts
  persistence/crew-members.repository.ts
  persistence/crew-results.repository.ts
  persistence/crew-artifacts.repository.ts
  persistence/crew-writer-leases.repository.ts
  crew-profile.resolver.ts
  crew-context.service.ts
  crew-artifact.store.ts
  crew-verifier.service.ts
  crew-runtime-tools.service.ts
  crew-runner.service.ts
  crew-recovery.service.ts
  crew-attention.service.ts
```

Existing source likely touched:

- `apps/server/src/db/database.service.ts` — tables/indexes + guarded columns.
- `apps/server/src/app.module.ts` — import Crew module.
- `apps/server/src/agents/agents.types.ts` — generic runtime policy and declared support.
- `apps/server/src/agents/providers/codex-agent.provider.ts` and `claude-agent.provider.ts` — map per-session read-only/workspace-write policy; no Crew imports.
- `apps/server/src/agents/tools/agent-tool-registry.ts` — merge role-scoped Crew tools.
- `apps/server/src/sessions/domain/sessions.types.ts`, `persistence/sessions.repository.ts`, `sessions.service.ts` — persist policy/verify owner, skip Solo verifier for Crew-owned sessions, pass runtime policy to provider.
- `apps/server/src/tasks/tasks.types.ts`, `task-row-mapper.ts`, `tasks.repository.ts`, `tasks.service.ts` — Crew correlation, `crew-member` role, existing-session continuation, settlement callback data.
- `apps/server/src/git/git.service.ts` / `git.types.ts` — full HEAD, clean/reachable checks.
- `apps/server/src/projects/projects.types.ts`, `projects.repository.ts`, `project-defaults-resolver.ts` — default Crew profile.
- `apps/server/src/attention/attention.types.ts` — `crew-blocked` severity; Crew service raises/clears it from durable run state.
- `apps/server/src/sessions/session-verifier.ts` — extract shared command execution or leave compatibility wrapper delegating to Crew verifier core.

Avoid changing provider-specific model catalogs, session FSM, existing session event union, or frozen WS relay in the first slice.

## TDD matrix

Create `apps/server/test/unit/crew/` and write RED specs in this order:

| Spec | Required cases |
|---|---|
| `crew-run.reducer.spec.ts` | Exact happy path; every illegal tuple/event; disabled-gate skip; terminal immutability; duplicate idempotency; stale context/head; cap exhaustion; pause/provider/recovery preservation. |
| `crew-profile.resolver.spec.ts` | Live provider/model validation; read-only/workspace-write support; reviewer independent from builder; run > project > saved > preset precedence; unavailable binding => needs setup; snapshot immutable after profile edit; no silent provider switch. |
| `crew-repositories.spec.ts` | Fresh schema; migration-from-nothing; positional params; event seq uniqueness; idempotency uniqueness; CAS conflict; transaction rollback; replay equals projection. |
| `crew-writer-lease.spec.ts` | One lease per run; second writer rejected; wrong token cannot release; stale boot lease moves run to recovering; cancel releases. |
| `crew-context.spec.ts` | Role-specific fields; byte budgets; no hidden/full transcript; progressive artifact range; cross-run/artifact path denied; context revision increments deterministically. |
| `crew-runtime-tools.spec.ts` | Only declared member can submit; schema validation; forged run/member/head rejected; duplicate submission idempotent; reviewer cannot write; builder cannot self-certify verify/review. |
| `crew-verifier.spec.ts` | Pass/fail/timeout/spawn error; full log file + SHA; secret redaction; bounded preview; current full HEAD; output overflow cannot yield a green gate; interrupted attempt recovery. |
| `crew-runner.spec.ts` | PLAN→BUILD→VERIFY→REVIEW→SYNTHESIZE; same builder session on feedback; blocker returns to build; warning does not; missing structured result blocks; no task double-enqueue after duplicate settlement. |
| `crew-recovery.spec.ts` | Crash at every durable boundary; queued attempt resumes; RUNNING task `daemon_restart` maps to RECOVERING; resumable thread steer; missing thread creates successor; changed/missing worktree blocks; unknown side effect never blindly retries. |
| `crew-attention.spec.ts` | One deduped item per blocked run/reason; boot reconciliation; clear only after run unblocks; manual Attention resolve does not alter Crew gate. |
| `crew.controller.spec.ts` | Validation, 404/409, expected revision, no raw transition injection, successor run keeps prior immutable. |

Extend existing regression suites:

- `apps/server/test/unit/tasks/tasks.repository.spec.ts` — continuation task fields and Crew correlation while preserving FIFO/current restart contract (`:78-156`).
- `apps/server/test/unit/tasks/tasks.service.spec.ts` — continue same session; boot-replayed failed attempt reaches Crew recovery; existing standalone retry unchanged (`:703-739`).
- `apps/server/test/unit/sessions/sessions.verify-gate.spec.ts` — `verify_owner=crew` produces no session `verify_*` events; default Solo still does (`:70-111`).
- `apps/server/test/unit/sessions/sessions.restart-reconcile.spec.ts` — member thread id survives and is steerable after restart (`:70-150`).
- `apps/server/test/unit/agents/codex-agent.provider.spec.ts` and `claude-agent.provider.spec.ts` — runtime-policy mappings and unsupported-policy rejection.
- `apps/server/test/unit/db/database.service.spec.ts` — fresh tables/indexes, guarded columns, old DB data preserved; existing tests show the required migration pattern (`:19-125`; `:216-298`).
- HTTP e2e with forced Mock: create Crew run, reach successful terminal state, replay events from cursor, then restart mid-BUILD and recover without duplicate run/member attempt.

Run server tests from `apps/server` cwd; repo-root execution can break Nest DI metadata (`AGENTS.md:631-637`). Final gate: targeted RED/GREEN commands, server unit, e2e, `bun run gate`, then `bun run gate:full` for the user-visible workflow (`docs/testing-and-verification.md:27-31`).

## Recovery and correctness risks

1. **Task/session boot ordering.** Current task boot deliberately converts all RUNNING rows to `FAILED: daemon_restart` while queued work resumes (`apps/server/src/tasks/tasks.service.ts:96-105`; verified by `apps/server/test/unit/tasks/tasks.service.spec.ts:716-739`). Crew must register for replayed terminal attempts and translate this specific outcome to Crew `RECOVERING`, not terminal failure.
2. **Double verification.** `SessionsService` currently runs verification after every provider turn (`apps/server/src/sessions/sessions.service.ts:1398-1430`; `apps/server/src/sessions/sessions.service.ts:1432-1501`). Without persisted ownership, Crew and Solo loops race and spend different budgets.
3. **Dirty-worktree false freshness.** Current snapshot uses short HEAD plus dirty-file preview (`apps/server/src/orchestration/workspace-snapshot.ts:87-107`). Require clean committed phase boundaries and full SHA.
4. **Permission honesty.** Provider capability flags presently cover interrupt/model/effort/images/steer only (`apps/server/src/agents/agents.types.ts:22-29`). Do not label a profile Ready until adapters prove per-session read-only/workspace-write enforcement with network disabled.
5. **Structured-result absence.** Existing digest uses the last assistant message (`apps/server/src/orchestration/outcome-digest.builder.ts:27-49`; `apps/server/src/orchestration/outcome-digest.builder.ts:127-154`). Missing Crew result must block/recover, never silently treat prose as proof.
6. **Event races.** Use revision CAS + unique idempotency keys, not `MAX(seq)+1` alone; duplicate provider callbacks and task-finish replays must be harmless.
7. **Artifact leakage/size.** Store logs outside SQLite, redact before durable write, scope reads by run, and fail closed if the evidence cap is exceeded; a truncated preview cannot certify success.
8. **Workspace disappearance or external edits.** On every attempt and boot, validate path, branch, full HEAD, clean state, and ancestry. Divergence creates `BLOCKED_USER`/Attention instead of resetting or checking out silently.
9. **Provider thread optimism.** `canResumeThread` only states that a durable handle exists; actual resume can still fail. Recovery order is resume thread -> same workspace successor session -> Attention, matching the proposed design (`docs/crew-workspace-harness.md:300-325`).
10. **Shutdown writes.** Existing repositories guard a closing DB and SessionsService tracks pending async work (`apps/server/src/sessions/sessions.service.ts:101-108`). Crew runner/verifier must implement the same bounded drain and never write after close.

## Phased implementation order

1. **Contract foundation:** pure types/reducer, profile resolver, schema/repositories, CAS/idempotency, project default. No runner.
2. **Authority boundary:** generic per-session runtime policy + provider adapter mappings; Crew-owned verify switch; profile readiness tests. Do not proceed until read-only reviewer and workspace-confined builder are empirically proven.
3. **One-worktree execution:** CrewTask/Run create API, worktree/head service, writer lease, member/task/session correlation, structured runtime tools.
4. **Fixed workflow:** PLAN→BUILD→VERIFY→REVIEW→SYNTHESIZE, same-member continuation, shared fix cap, full-log artifacts, Attention.
5. **Recovery:** boot replay, task-failure translation, provider resume/successor fallback, stale head/worktree cases, successor CrewRun.
6. **HTTP/e2e + client handoff:** detail/events cursor API, forced-Mock lifecycle/restart e2e, docs/changeset, then web/mobile Crew UI work.

Do not combine phases 1–4 into one large change: runtime-policy enforcement is the safety gate for calling the MVP production-ready.

## Unresolved questions

1. Confirm the smallest defaults: auto-proceed plan inside profile, blocker-only review gate, one shared `maxFixRounds`, automatic local completion after synthesis, no gate exceptions, and no publishing.
2. Reviewer freshness: reuse the reviewer session across fix rounds (smallest) or require a fresh final reviewer.
3. Successor continuity: may a successor reuse foreman/builder threads only when profile binding, worktree, and full HEAD all match (recommended)?
4. Retention remains undecided; MVP recommendation is retain everything and expose no purge until explicit durations are chosen.
5. Verify scripts are user-controlled shell commands. Confirm they are treated as trusted/idempotent local checks for restart re-run, or require user attention after an interrupted verify.
