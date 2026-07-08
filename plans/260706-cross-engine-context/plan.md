# Cross-Engine Context & Handoff — Program Plan

**Status:** EXECUTED (2026-07-07) — all workstreams shipped on this branch except C4 (rung-4
gated) and D6 (rung-2 gated). See the Execution record at the bottom for deltas between this
spec and what landed. Originally drafted 2026-07-06; fully-specified — every implementation
task in this program is written out in the workstream docs.
**Relationship to mission control:** this program is the connective tissue between rungs 1–4 of
[260706-mission-control](../260706-mission-control/plan.md). Workstream A lands inside the rung-1
task lane; B is rung-2 adjacent (project entity); C pulls the read-only slice of rung-4
(nuncio-as-MCP) forward via the existing runtime-tools seam; D is net-new (prompt profiles +
behavioral eval suite) and feeds rung-4 observability.

**Thesis:** engines today collaborate only by accident (shared repo). The scarce resource in a
handoff is context, and the wasteful way to move it is transcript replay. This program makes
handoff artifacts first-class: a structured **brief** flows down when work is delegated, a
structured **digest** flows up when it finishes, durable **facts** persist per project, and
per-engine **prompt profiles** control how those artifacts are rendered — measured by a
behavioral **eval suite** instead of vibes.

## Design principles (bind every task below)

1. **Artifacts, not transcripts.** No feature may copy another session's raw event log into a
   prompt. Cross-session context moves as: brief (≤ ~2 KB), digest (≤ ~1 KB), facts (≤ 4 KB
   budget), or an explicit pull through a runtime tool with a byte budget.
2. **Engine-neutral core, per-engine rendering at the edge.** Canonical shapes are plain
   TypeScript interfaces rendered to plain markdown. Anything engine-specific lives in a prompt
   profile (data), never in orchestration code. ADR-004 engine test applies: zero
   `if (provider === '…')` outside adapters.
3. **Refs over contents.** Same-machine handoffs carry paths, branch names, and SHAs; the
   receiving engine reads files itself. File contents are embedded only when the receiver cannot
   reach the workspace.
4. **Verify is the lingua franca.** "Done" is decided by a verify script, never by an engine's
   claim. Every brief carries the verify command; every digest carries the verify result. The
   eval suite (workstream D) is the same idea applied to prompts themselves.
5. **Restart test.** All new state (briefs, digests, facts, lineage, profiles, eval baselines)
   lives in SQLite or the repo — nothing in daemon memory. A restart mid-delegation loses
   nothing.
6. **Annotate, don't block.** Digests and facts append events / rows; they never gate the
   session FSM (inherited founder lock from 260702-task-queue).
7. **No plan taxonomy in code.** Task IDs below (A1…, E01…) exist only in these docs and PR
   descriptions. Code, tests, migrations, and commits use domain names
   (`handoff-brief.renderer.ts`, `TestSubagentDigestAppendsToParent`), never IDs.

## Workstreams & task index

Every task is specified in full (schema, types, wiring, tests, acceptance) in its workstream doc.

| # | Task | Doc |
|---|------|-----|
| A1 | Handoff brief type + storage + renderer | [workstream-a](workstream-a-delegation-loop.md) |
| A2 | Deterministic brief assembler for subagent spawn | workstream-a |
| A3 | Workspace snapshot helper (git refs, not contents) | workstream-a |
| A4 | `task_completed` digest event → parent log | workstream-a |
| A5 | Parent notify policy (event-only vs auto-steer) | workstream-a |
| A6 | Session lineage columns + API | workstream-a |
| A7 | Web UI: digest card, brief inspector, lineage chip | workstream-a |
| B1 | `context_facts` table + repository + service + API | [workstream-b](workstream-b-shared-context.md) |
| B2 | Fact injection into session preamble (budgeted) | workstream-b |
| B3 | Fact provenance & founder-precedence rules | workstream-b |
| B4 | Per-engine context-file materialization (opt-in, worktree-local) | workstream-b |
| B5 | `renderEventsSince` compact replay helper | workstream-b |
| C1 | Orchestration runtime tools — read-only set | [workstream-c](workstream-c-orchestration-tools.md) |
| C2 | Write tools: `enqueue_task` (brief-authored) + `record_project_fact` | workstream-c |
| C3 | Tag-based engine routing table (dispatcher-lite, deterministic) | workstream-c |
| C4 | Standalone MCP server wrapping the same registry (rung-4 alignment) | workstream-c |
| D1 | Prompt profiles as data (repo defaults + DB overrides) | [workstream-d](workstream-d-prompt-profiles.md) |
| D2 | Profile-aware rendering of briefs/facts/digests | workstream-d |
| D3 | Behavioral eval harness (hermetic runner + fixtures + report) | workstream-d |
| D4 | Full eval task set — all 18 tasks specified | [eval-suite](eval-suite.md) |
| D5 | Baseline + regression compare command | workstream-d |
| D6 | Model onboarding pipeline (fetch → distill → baseline → variants → approve) | workstream-d |

## Sequencing & dependencies

```
Phase 1 (inside rung-1 task lane):  A3 → A1 → A2 → A4 → A6 → A7 → A5
Phase 2 (founder re-order, 2026-07-07 — agent-to-agent delegation first):
                                    C1 → C2 → C3
Phase 3 (parallel):                 B1 → B2 → B3 → B5        D1 → D2
Phase 4 (needs C, D1):              D3 → D4 → D5              B4 (needs D1)
Phase 5 (needs D3, rung-2 loops for full automation): D6, C4
```

Re-order rationale: the overnight-autonomy chain (task → verify-loop → digest steers parent →
parent enqueues corrected follow-up) needs the enqueue tool; facts/profiles compound value but
don't unlock a new loop. C1/C2's read-tool guards that referenced the facts store (B1) degrade
gracefully: `nuncio_list_project_facts` ships with C-phase only if B1 exists, else it is
omitted from the tool list until B1 lands.

- A5 ships last in phase 1 because it is the only behavior-changing switch (auto-steer);
  everything before it is additive.
- D1/D2 have no dependency on A/B/C beyond A1's renderer existing — they can start any time.
- D4 tasks E17 and E18 are gated on C2 (they exercise the delegation tools).

## Founder decision points (locked before the touching task starts)

| Decision | Options | Suggested default | Blocks |
|----------|---------|-------------------|--------|
| Parent notify default | `event-only` / `steer` | **LOCKED (founder, 2026-07-07): `event-only` global default, `steer` per-task opt-in** | A5 |
| Digest summary source | last `assistant_message` tail (deterministic) vs LLM-summarized | deterministic v1 | A4 |
| Fact write authority | agents write facts directly vs propose-only | agents propose, founder-confirm; direct writes only via C2 tool flagged `agent` provenance | B3 |
| Context-file policy default | `none` / `worktree-local` | `none` (repo-owned CLAUDE.md/AGENTS.md never touched) | B4 |
| Profile storage | repo files + DB overrides (proposed) vs DB-only | repo files + DB overrides | D1 |
| Eval fixture language | TypeScript/bun only vs mixed | TS/bun only v1 (matches house stack) | D3 |
| Routing table location | settings JSON vs new table | settings JSON v1 (`NUNCIO_ENGINE_ROUTING`) | C3 |

## Guardrails

- **Engine test:** all wiring goes through `AgentProvider` / `AgentRuntimeTools`
  ([agents.types.ts](../../apps/server/src/agents/agents.types.ts),
  [agent-runtime-tools.types.ts](../../apps/server/src/agents/tools/agent-runtime-tools.types.ts)).
  Per-engine differences live in prompt-profile data and the two existing runtime-tool adapters.
- **Not an LLM harness:** nuncio never calls a model API directly. LLM-authored briefs/digests
  (v2 paths) happen inside provider sessions, or not at all.
- **ADR-011 engine scope:** this program adds zero engines. The eval suite runs against engines
  already installed; a missing CLI login skips that engine with an explicit report row.
- **Payload hygiene:** every new event payload respects `truncatePayload`
  ([events.types.ts:73](../../apps/server/src/sessions/domain/events.types.ts)); digests and
  briefs carry their own smaller budgets (specified per task).
- **File size:** new code files stay under ~200 lines; renderers, assemblers, and repositories
  are split by responsibility.

## Non-goals

- No DAG / general workflow engine — briefs and digests decorate the existing straight
  task chain.
- No cross-machine handoff — single daemon, single SQLite (ADR-001 holds).
- No automatic rewriting of repo-owned context files (CLAUDE.md, AGENTS.md, .cursorrules).
- No RL / fine-tuning in the onboarding pipeline — prompt-space search only.
- No eval-score-driven automatic profile activation — founder approves every profile change.

## Execution record (2026-07-07)

Everything below shipped on branch `practical-roentgen-a92f55` (~50 commits), each batch
independently verified and adversarially reviewed (Codex xhigh) to CLEAN or ledgered
acceptance. Ledgers: `.claude/maestro/cross-engine-context-*/edge-cases*.md`.

**Shipped:** A1–A7 and A5 (notify policy, locked `event-only` default) · B1–B5 + B4 ·
C1–C3 (C4 pending, rung 4) · D1–D5 (D6 pending, rung 2). All 18 eval tasks + harness +
baseline/compare; `bun run eval:engines` / `eval:compare` are live.

**Material deltas from spec (details in workstream docs and ledgers):**
- Steer-queue fan-out was redesigned to claim/lease semantics (`claimed_at`), transactional
  insert+delete, release-with-redrain — the spec'd drain-first order lost messages on crash.
- Digest append is atomic with task finish (one transaction; provider delta-buffer flushed
  BEFORE the transaction; WS emit after commit); the payload budget is enforced on
  SERIALIZED bytes with a convergent trim loop + progress guard.
- Depth cap semantics: the FINISHING session's chain (parent+1) — only depth-1 children may
  auto-wake their root parent.
- The brief travels as `CreateSessionDto.contextBrief`; composition happens once in
  `SessionsService.create` (session-preamble choke point), not in TasksService.
- Proposals are capped at 3 pending per (project, key), replace-oldest.
- Orchestration tools re-check the live mode at execute() (registration drift on long-lived
  provider handles is accepted + ledgered); null projectPath matches nothing.
- Eval runner extensions beyond spec: `scoring: "hidden-only"`, `informational: true` (both
  pinned-set guarded), `daemonEnv` (allowlisted to 2 keys), baseUrl passed to hidden checks,
  one aggregated report per (engine, model).
- `--stamp-profile` emits a paste-ready evalScore block instead of writing the DB override
  (hermetic daemons are gone by stamp time; graduation stays a founder action).
- Suite-integrity patterns adopted after adversarial review: SHA-pinning on deterministic
  fixtures (amend-proof), canonical-rebuild byte-equality (hand-edit-proof), runtime-tool
  event as delegation proof (API-forge-proof), line-anchored survival checks, two-layer
  verify with runner-side hidden checks. Full-suite mock run: every task executes end-to-end;
  mock fails non-solvable tasks honestly.
- Known open: intermittent pre-existing watcher-timing flake in the server suite (~1/3 runs;
  chip pending); GitLab Duo quota exhausted mid-program (channel priority ledger in memory).

## Program-level done-when (dogfood criteria)

1. A parent session delegates two subagents; each receives a brief, finishes, and its digest
   appears in the parent transcript — founder never opens a child transcript to know the outcome.
2. A brand-new worktree session on a project immediately knows the project's three standing
   facts without the founder retyping them.
3. `bun run eval:engines` produces a per-engine pass-rate table for all 18 eval tasks against
   every installed engine, twice, with identical fixture states (hermetic).
4. Changing one line of a prompt profile and re-running the eval shows the delta in the compare
   report — the loop from "prompt idiom hunch" to "measured" is closed.
