# Findings 03 — Cross-engine handoff: what exists, what's missing

## Provider architecture facts

- Providers in `apps/server/src/agents/providers/` (pi, cursor SDK, cursor CLI, codex, claude,
  devin, mock) behind `AgentProvider` (`agents.types.ts:169`) + `BaseAgentProvider`.
- Session ↔ provider+model binding is **fixed at creation** (`SessionRow.provider/model`).
  Only the *model* can switch mid-session (`setModel`, Claude+Pi, `PATCH /sessions/:id/model`,
  `modelSwitch` capability). **No switchProvider exists** → engine change = new session.

## Already-built handoff plumbing (cross-engine context program, executed 2026-07-07)

All shipped except C4 (nuncio-as-MCP) and D6 (model onboarding):

1. **Context pack from transcript:** `context/events-compactor.ts` `renderEventsSince(events,
   budgetBytes, scope)` — deterministic engine-neutral markdown, byte-budgeted, newest-first
   eviction. Today exposed only as *pull* tools (`read_session_history`, `nuncio_read_session`).
2. **Brief/digest artifacts:** `orchestration/handoff-brief.{types,renderer,assembler}.ts`,
   `workspace-snapshot.ts` (branch/HEAD/dirty/diffstat — refs only), `outcome-digest.builder.ts`.
3. **Seeding a new session:** `CreateSessionDto.contextBrief` → injected at the single choke
   point `composeSessionPreamble` (`sessions.service.ts:399-419`, order brief→facts→workspace→
   prompt); `continueExistingSession` also accepts `contextBrief`.
4. **Lineage:** `parent_session_id`, `origin_task_id`, `prior_session_id` +
   `GET /sessions/:id/lineage`; UI digest cards/brief inspector/lineage chip shipped.
5. **Engine routing:** `orchestration/engine-routing.ts` (`resolveTaskEngine`,
   `avoidAuthorProvider`); task queue can re-route a held task's provider/model
   (`TasksService.update`, surfaced as `subagents-panel.tsx onChangeModel`).
6. **Existing "handoff" API is a different thing:** `POST /api/sessions/handoff` +
   `handoff-picker.tsx` = *same-engine adoption* of an external Cursor/Pi CLI chat
   ("continue on mobile"), via `sessions.repository.createHandoff` + `priorSessionId`.

## Missing (~20%)

- A **"continue this session on provider X"** action: nothing composes
  `renderEventsSince(source)` + workspace snapshot and *pushes* it into a new session's
  `contextBrief` with the same worktree. Composition + route + UI are the gap.
- **Workspace snapshot on plain session create** (today only subagent briefs get it —
  `plans/260719-agent-codebase-context-study/codebase-context-study.md:60-64`).
- **Worktree co-ownership contract** (two sessions, one `worktree_path`; cleanup ownership).
- **Capability reconciliation** at handoff time (target lacks a mode/effort the source used →
  message, not silent drop).

## Synara's shipped design (validation + details to copy)

Source paths relative to their repo (clone in scratchpad):

- **UI:** "Hand off" menu in `chat/ChatHeader.tsx` — one item per *usable* target provider
  (availability-checked, disabled while busy), brand icons, plus a persistent source→target
  badge on handed-off threads.
- **Client:** `hooks/useThreadHandoff.ts` + `lib/threadHandoff.ts` — serialize completed
  user/assistant messages (fresh ids, attachments kept), carry title, target model resolution
  (sticky per-provider → project default → provider default), runtime/interaction/env modes,
  **same branch + worktree path**, then dispatch one `thread.handoff.create` command and
  navigate to the new thread.
- **Server:** `orchestration/decider.ts` creates a **fresh thread** for the target engine with
  `handoff:{sourceThreadId, bootstrapStatus:'pending'}`; transcript stored as display-only
  `handoff-import` rows. **Not a native resume.**
- **Injection:** `orchestration/handoff.ts` builds a budgeted pack — last 6 messages verbatim
  (2,400 chars each), older collapsed to 320-char bullets, budget `min(0.75×provider max,
  32,000)` chars, prefixed with title/branch/worktree + "This conversation was handed off from
  {provider}." Injected **once on the first native turn** wrapped as
  `<handoff_context>…</handoff_context>` before `<latest_user_message>`, then
  `bootstrapStatus:'completed'`.
- **Guards:** cannot re-hand-off until the new thread has ≥1 native message.

## Proposed nuncio shape (maps 1:1 onto existing seams)

`POST /api/sessions/:id/handoff-to { provider, model? }`:
1. Verify target provider available (`AgentRegistry`), reconcile capabilities.
2. Build pack: `renderEventsSince(events, budget)` + `buildWorkspaceSnapshot(workingDir)`.
3. `SessionsService.create({ provider, model, workspace/worktreePath/branch/projectPath =
   source's, contextBrief = pack, priorSessionId: source.id })` — nuncio injects at create via
   `composeSessionPreamble`, which is *simpler* than Synara's first-turn bootstrap and already
   one-shot.
4. Mark source handed-off (quiesce provider; worktree ownership → successor).
5. UI: header "Hand off" menu (next to model switch) + source→target badge + existing lineage
   chip. Also surface the task-inbox engine picker (parity with `subagents-panel onChangeModel`).

Open question for Oscar: transcript budget — Synara ~32KB chars; `renderEventsSince` is
byte-budgeted already, pick a default (e.g. 24–32KB) and let per-engine max override.
