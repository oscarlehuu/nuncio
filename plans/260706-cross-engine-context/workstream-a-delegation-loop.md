# Workstream A — Delegation Loop (brief down, digest up)

Everything here lands inside the rung-1 task lane. Current gap: `buildSubagentTaskInput`
([multitask-defaults.ts:17](../../apps/server/src/tasks/multitask-defaults.ts)) copies
provider/model/workspace but **zero content context**, and a finished task writes `outcome_json`
that the parent session never sees.

---

## A1 — Handoff brief: type, storage, renderer

**Goal.** A canonical, engine-neutral brief travels with every delegated task and is prepended
to the child's first prompt as plain markdown.

**New types** — `apps/server/src/orchestration/handoff-brief.types.ts`:

```ts
export interface HandoffBrief {
  /** One-sentence objective. Required. */
  goal: string;
  /** Hard constraints the child must not violate. */
  constraints?: string[];
  /** Decisions already made upstream — the child must not relitigate these. */
  decisions?: string[];
  /** Repo-relative paths the child should start from (refs, never contents). */
  files?: string[];
  /** Command that decides done. Mirrors the project verify command when unset. */
  verifyCommand?: string;
  /** Explicit done criteria, checkable by the child. */
  doneCriteria?: string[];
  /** Workspace snapshot at delegation time (see A3). */
  workspace?: WorkspaceSnapshot | null;
  /** Provenance: which session authored this brief, and at which event seq. */
  sourceSessionId?: string;
  sourceSeq?: number;
}
```

Budget: rendered brief ≤ 2048 bytes. The renderer truncates `files` first, then `decisions`,
then `constraints`, never `goal`/`doneCriteria`/`verifyCommand`; when it truncates, it appends
`_(brief truncated)_`.

**Renderer** — `apps/server/src/orchestration/handoff-brief.renderer.ts`:
`renderHandoffBrief(brief: HandoffBrief): string`. Plain markdown, fixed section order:
`## Handoff brief` → goal paragraph → `Constraints:` list → `Decisions already made:` list →
`Start from:` file list → `Workspace:` snapshot lines → `Done when:` list +
`` Verify: `<command>` `` line. No engine-specific syntax here — that arrives in D2 as an
optional profile-supplied wrapper.

**Storage.**
- Migration in [database.service.ts](../../apps/server/src/db/database.service.ts) `migrate()`,
  same PRAGMA-guarded pattern as existing columns:
  `ALTER TABLE tasks ADD COLUMN context_json TEXT`.
- [tasks.types.ts](../../apps/server/src/tasks/tasks.types.ts): `TaskRow.context_json:
  string | null`; `TaskDto.contextBrief: HandoffBrief | null`; `CreateTaskDto.contextBrief?:
  HandoffBrief`. Mapper in `task-row-mapper.ts` parses with try/catch → null on corrupt JSON
  (never throws on read).

**Wiring.** `TasksService.execute()`
([tasks.service.ts:166](../../apps/server/src/tasks/tasks.service.ts)): when
`task.contextBrief` is set, the session is created with
`prompt = renderHandoffBrief(brief) + '\n\n---\n\n' + task.prompt`. `task.prompt` stays pure in
the DB (retry/clone semantics unchanged — `retry()` must also carry `contextBrief` forward; add
it to the spread list at tasks.service.ts:111).

**API.** `POST /api/tasks` and multitask DTOs accept `contextBrief` (validated: `goal` required
non-empty; arrays of strings; reject anything > 8 KB pre-render).

**Tests (level 1 first).**
- Renderer table test: full brief, minimal brief (goal only), over-budget brief (assert
  truncation order and marker), empty arrays omitted.
- Tasks service spec: enqueue with brief → session created with composed prompt; without brief
  → prompt untouched; corrupt `context_json` row → task listed with `contextBrief: null`.
- Retry spec: retried task carries the same brief.

**Acceptance.** A task created with a brief produces a child session whose first
`user_message` event begins with `## Handoff brief` and ends with the original prompt.

---

## A2 — Deterministic brief assembler for subagent spawn

**Goal.** Multitask spawns get a useful brief with zero LLM cost. (LLM-authored briefs arrive
free with C2, where the parent engine writes the brief itself as tool arguments.)

**Module** — `apps/server/src/orchestration/handoff-brief.assembler.ts`:

```ts
export function assembleSubagentBrief(input: {
  parent: SessionDto;
  parentTailEvents: SessionEventDto[];  // events.listTail(parent.id, 200)
  workspace: WorkspaceSnapshot | null;  // A3
  verifyCommand: string | null;         // settings resolve, see below
}): HandoffBrief
```

Deterministic extraction rules:
- `goal`: the delegated prompt itself is the goal — the assembler sets goal to the parent's
  original `prompt` field prefixed `Parent objective: ` **only as a decision line**, not the
  goal. Concretely: `goal` = the subagent prompt (first 200 chars); `decisions` gets
  `Parent objective: <parent.prompt first 200 chars>`.
- `files`: repo-relative paths harvested from the parent's tail `tool_start`/`tool_end`
  payloads (`isToolStartEvent` guard, then duck-type `input.file_path | input.path | input.cwd`
  string fields; keep order of last touch, dedupe, cap 10). Paths outside the project root are
  dropped.
- `verifyCommand`: `settings.resolve('NUNCIO_VERIFY_COMMAND')` scoped the same way
  [session-verifier.ts](../../apps/server/src/sessions/session-verifier.ts) resolves it (reuse
  its resolution helper — extract it if currently private).
- `workspace`: passed through from A3.
- `sourceSessionId` = parent.id; `sourceSeq` = last tail event seq.

**Wiring.** `buildSubagentTaskInput()` gains an optional `brief` parameter;
`TasksService.startMultitask` / `startMultitaskFromQueue` call the assembler once per parent
(shared across the batch except `goal`) and attach per-prompt briefs. Callers may override by
passing an explicit `contextBrief` in `StartMultitaskDto`.

**Tests.** Assembler table test with a synthetic parent event tail: extracts and dedupes file
paths, caps at 10, drops absolute paths outside project root, handles a parent with no tool
events (files omitted), handles null workspace.

**Acceptance.** `startMultitaskFromQueue` on a real parent produces child sessions whose briefs
list the files the parent actually touched.

---

## A3 — Workspace snapshot helper

**Goal.** Handoffs carry cheap, precise git refs instead of prose or file contents.

**Module** — `apps/server/src/orchestration/workspace-snapshot.ts`:

```ts
export interface WorkspaceSnapshot {
  branch: string | null;
  headSha: string | null;        // short SHA
  baseBranch: string | null;
  dirtyFiles: string[];          // porcelain paths, cap 20 + `…and N more`
  diffStat: string | null;       // `git diff --stat <base>...HEAD`, cap 1024 bytes
}
export async function buildWorkspaceSnapshot(
  cwd: string, baseBranch?: string | null,
): Promise<WorkspaceSnapshot | null>
```

Implementation: `Bun.spawn` git subcommands (`rev-parse --abbrev-ref HEAD`,
`rev-parse --short HEAD`, `status --porcelain`, `diff --stat`), each with a 3 s timeout;
any git failure (not a repo, timeout) → return `null`, never throw. No caching — snapshots are
taken at delegation/finish moments only, not per keystroke.

**Consumers.** A2 (brief, snapshot of parent workspace at spawn) and A4 (digest, snapshot of
child workspace at finish).

**Tests.** Level-1 against a temp git fixture created in the spec (init, commit, dirty a file):
correct branch/sha/dirty list; non-git dir → null; diffStat present when base branch given.
No mocking of git itself — real subprocess against a tmp dir (fast, hermetic).

**Acceptance.** Snapshot of this repo's worktree returns branch + sha + dirty files in < 500 ms.

---

## A4 — `task_completed` digest event on the parent log

**Goal.** When a subagent task reaches a terminal state, the parent session's event log receives
a compact digest — the parent (human or engine) never reads the child transcript to learn the
outcome.

**Event type.** Add to `SessionEventType`
([events.types.ts:5](../../apps/server/src/sessions/domain/events.types.ts)): `task_completed`.

```ts
export interface TaskCompletedPayload {
  taskId: string;
  childSessionId: string | null;
  status: 'DONE' | 'FAILED' | 'CANCELLED';
  /** Tail of the child's final assistant_message, ≤ 1024 bytes (deterministic v1). */
  outcomeSummary: string | null;
  verify: { passed: boolean; output?: string } | null;  // output ≤ 512 bytes
  workspace: WorkspaceSnapshot | null;                  // child worktree at finish
  childBranch: string | null;                           // where the work lives
}
```

Plus a `isTaskCompletedEvent` type guard following the existing guard pattern.

**Digest builder** — `apps/server/src/orchestration/outcome-digest.builder.ts`:
`buildOutcomeDigest(task, childSessionId, events, workspace): TaskCompletedPayload`.
`outcomeSummary` = last `assistant_message` payload text, tail-truncated to 1024 bytes
(deterministic; the founder decision table in plan.md gates any LLM-summarized v2).

**Wiring.** `TasksService.execute()` finally-block: after `this.tasks.finish(...)`, if
`task.parentSessionId` and the parent session still exists, append the event through
`SessionsService` (a new `appendOrchestrationEvent(sessionId, type, payload)` that assigns the
next seq, persists via `EventsRepository`, and fans out to WS subscribers — same path run events
take, so live parents update without reload). Failure to append is logged and swallowed: digest
delivery must never flip a DONE task to FAILED.

Cancellation (`cancel()`) also emits a digest with `status: 'CANCELLED'`, null summary.

**Tests.**
- Digest builder table test: DONE with verify pass, FAILED with error outcome, no
  assistant_message in tail (summary null), over-long message (truncation).
- Tasks service spec: subagent finish appends exactly one `task_completed` to the parent with
  correct seq ordering; standalone task (no parent) appends nothing; parent deleted →
  no throw.
- Conformance-suite row is **not** needed (this is session-layer, not provider-layer), but add a
  projection test once A7 renders it.

**Acceptance.** Parent transcript shows the digest event within 1 s of child task finish, after
a daemon restart mid-child-run included (restart reconciliation already fails the task; the
digest with `status: 'FAILED'` must still be appended by the boot-time `failInterrupted` path —
extend [tasks.service.ts:29](../../apps/server/src/tasks/tasks.service.ts) accordingly).

---

## A5 — Parent notify policy (event-only vs auto-steer)

**Goal.** Optionally close the loop: an idle parent engine is steered with the digest so it can
continue autonomously (judge the result, spawn a follow-up, or escalate).

**Setting.** `NUNCIO_DELEGATE_NOTIFY` = `event-only` (default) | `steer`. Per-task override
field `notifyPolicy?: 'event-only' | 'steer'` on `CreateTaskDto` + `tasks` column
`notify_policy TEXT` (same migration pattern).

**Wiring.** After A4 appends the digest: if effective policy is `steer` **and** the parent
session status is `IDLE`, call the existing steer path with a rendered digest message
(`renderOutcomeDigest(payload): string`, markdown, ≤ 1.5 KB, ends with
`Reply with next action, or reply DONE if the objective is met.`). If the parent is RUNNING,
enqueue into the existing steer queue instead (drained by current mechanics). If PAUSED/ERROR,
fall back to event-only.

**Loop guards (hard, non-configurable v1):**
- Depth cap: a session whose own `parent_session_id` chain length ≥ 2 never auto-steers its
  parent (prevents ping-pong chains). Chain length computed via A6 lineage.
- Per-parent cap: max 5 auto-steers per parent session per hour (count `steer_message` events
  whose payload carries `origin: 'task-digest'`).

**Tests.** Policy matrix spec: IDLE+steer → steer called; RUNNING+steer → queued; default →
neither; depth-cap and rate-cap paths. Digest-message renderer snapshot-free assertion (contains
verify line, ends with the action sentence).

**Acceptance (rung-1 dogfood).** Parent delegates a fix; child fails verify; parent (steer
policy) receives the digest and issues a corrected follow-up task with zero founder input.

---

## A6 — Session lineage

**Goal.** Parent/child and handoff-chain relationships are queryable and visible.

**Schema.** `sessions` migration: `parent_session_id TEXT`, `origin_task_id TEXT`,
`prior_session_id TEXT` (linear handoff chains, e.g. mobile-continue; distinct from tree
parentage). Index: `CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)`.

**Wiring.**
- `TasksService.execute()` passes `parentSessionId: task.parentSessionId ?? undefined` and
  `originTaskId: task.id` into `sessions.create` (extend `CreateSessionDto` + insert).
- The existing mobile handoff endpoint sets `prior_session_id` on the successor session.
- `SessionDto` exposes `parentSessionId`, `originTaskId`, `priorSessionId`;
  `GET /api/sessions/:id/lineage` returns `{ ancestors: SessionRefDto[], children:
  SessionRefDto[] }` where `SessionRefDto = { id, title, status, provider }` (ancestors walk
  capped at 10 to survive cycles; cycle detection by visited-set).
- A5's depth cap consumes the ancestor walk.

**Tests.** Repository spec: lineage columns round-trip; ancestor walk stops at 10 and on a
manufactured cycle; children list ordered by created_at.

**Acceptance.** For a parent with two subagents, the lineage endpoint returns both children;
each child's ancestors list contains the parent.

---

## A7 — Web UI for the delegation loop

**Goal.** The founder sees the loop without opening child transcripts.

**Pieces (apps/web):**
1. **Digest card** in the transcript: `task_completed` renders as a card — status pill
   (DONE green / FAILED red / CANCELLED neutral), verify chip (reuse the existing verify-chip
   component), `outcomeSummary` in a collapsed-by-default block, child branch name, and an
   "Open session" link to the child. Pure projection from the event payload — write the
   projection function + table test first (per
   [testing-and-verification.md](../../docs/testing-and-verification.md) row 2), then the
   component.
2. **Brief inspector**: in the task inspector/queue view, a "Handoff brief" disclosure showing
   the rendered markdown of `contextBrief`. Read-only v1.
3. **Lineage chip** in the session header: when `parentSessionId` set, a small
   `↳ from <parent title>` chip navigating to the parent; when children exist, a `N subagents`
   chip opening the lineage list.
4. **Depth styling** follows the existing elevation ladder (`shadow-e1` card on the digest, no
   new visual language).

**Tests.** Projection table tests (level 2) for all three payload shapes; one scripted level-5
pass added to `scripts/smoke-ui.mjs` mock flow: mock provider parent + mock child task →
digest card visible, link navigates. Screenshot both themes (visual change).

**Acceptance.** Smoke run shows the digest card and working lineage navigation in real Chrome.
