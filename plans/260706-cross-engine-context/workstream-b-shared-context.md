# Workstream B — Shared Context Layer (durable facts, budgeted injection, compact replay)

Cross-engine memory that outlives sessions. Scoped by `project_path` today (string key); when
rung 2 introduces the project entity, these tables gain a `project_id` FK via a follow-up
migration — the service API is written against an opaque `projectKey` from day one so callers
don't churn.

---

## B1 — `context_facts` table + repository + service + API

**Goal.** Verified, durable, per-project facts every engine can read: build commands, gotchas,
standing decisions, "don't touch X".

**Schema** (in `database.service.ts` `migrate()`):

```sql
CREATE TABLE IF NOT EXISTS context_facts (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  key TEXT NOT NULL,              -- kebab-case slug, unique per project
  value TEXT NOT NULL,            -- plain markdown, ≤ 1024 bytes enforced in service
  provenance TEXT NOT NULL,       -- 'founder' | 'agent'
  source_session_id TEXT,         -- set when provenance = 'agent'
  pinned INTEGER NOT NULL DEFAULT 0,  -- pinned facts always injected first
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_path, key)
);
CREATE INDEX IF NOT EXISTS idx_context_facts_project
  ON context_facts(project_path, updated_at);
```

No `expires_at` v1 — facts are curated, not cached; staleness is handled by founder deletion
(YAGNI; revisit only if the store demonstrably rots).

**Repository** — `apps/server/src/context/context-facts.repository.ts`: `upsert`, `list`,
`get`, `delete`, `listPinnedFirst(projectPath, limit)`. **Service** —
`context-facts.service.ts`: validates key slug (`/^[a-z0-9][a-z0-9-]{1,63}$/`), value byte
budget (1024), enforces B3 precedence rules. **Module** — `context.module.ts`, imported by the
app module.

**API** — `apps/server/src/context/context-facts.controller.ts`:
- `GET  /api/context-facts?projectPath=…` → `ContextFactDto[]`
- `PUT  /api/context-facts` body `{ projectPath, key, value, pinned? }` (UI writes →
  provenance `founder`)
- `DELETE /api/context-facts/:id`

**Tests.** Repository round-trip + unique-key upsert semantics; service rejects bad slugs and
over-budget values; controller level-3 supertest for the three routes.

**Acceptance.** Facts survive daemon restart; two projects' facts never bleed into each other.

---

## B2 — Fact injection into the session preamble

**Goal.** Every new session on a project starts already knowing the facts — engine-neutrally,
within a byte budget.

**Renderer** — `apps/server/src/context/context-facts.renderer.ts`:
`renderContextFacts(facts: ContextFactDto[], budgetBytes: number): string`. Output:

```markdown
## Project facts (managed by nuncio)
- **build-command**: use `make weird-build`, not `bun run build` — the default target skips codegen
- **deploy-freeze**: no deploys to prod before 2026-07-15 (founder decision)
```

Selection: pinned first, then `updated_at` desc, greedily packed until the budget
(`NUNCIO_CONTEXT_FACTS_MAX_BYTES`, default 4096) is hit; a final line
`_(N more facts omitted — ask via context tools)_` when truncated (the tool reference renders
only when C1 tools are enabled for the session).

**Wiring.** Single choke point: the same prompt-composition step A1 introduced in
`TasksService.execute()` **and** direct session creation in `SessionsService.create()` gain a
shared helper `composeSessionPreamble({ brief?, facts?, profile? }): string` in
`apps/server/src/orchestration/session-preamble.ts`. Order: handoff brief → project facts →
original prompt. This helper is the one place D2 later threads profiles through. Injection only
when the session has a `projectPath` and the store is non-empty; a settings kill-switch
`NUNCIO_CONTEXT_FACTS_INJECT=off` disables globally.

**Tests.** Renderer table test: empty store (empty string, no header), pinned-first ordering,
budget packing (fact that doesn't fit is skipped, not truncated mid-fact), omission footer.
Preamble helper test: all-three / brief-only / facts-only / neither compositions.

**Acceptance.** New session on a project with facts shows them in its first `user_message`
event; session on a fact-less project shows no header at all.

---

## B3 — Fact provenance & founder precedence

**Goal.** Agents contribute knowledge without ever silently overriding the founder.

**Rules (enforced in `context-facts.service.ts`, unit-tested exhaustively):**
1. `founder` upsert always wins (over anything).
2. `agent` upsert on a non-existent key → written directly, provenance `agent`,
   `source_session_id` recorded.
3. `agent` upsert on an existing `agent` fact → overwrite allowed (latest wins).
4. `agent` upsert on an existing `founder` fact → **rejected**; stored instead in a proposals
   list: `context_fact_proposals (id, project_path, key, proposed_value, source_session_id,
   status 'pending'|'accepted'|'dismissed', created_at)` (same migration file). The tool result
   (C2) tells the agent "proposed, pending founder review".
5. Proposals surface in the web UI (B-scope: a badge on the facts panel; the rung-3 attention
   inbox later absorbs this feed — design the DTO now so it can be re-published there
   unchanged).

**API additions.** `GET /api/context-facts/proposals?projectPath=…`,
`POST /api/context-facts/proposals/:id/accept`, `POST …/dismiss`. Accept = founder-provenance
upsert + proposal `accepted`.

**Tests.** The 4-rule matrix as a table test; accept flow flips provenance to `founder`;
dismissed proposals don't re-propose duplicate pending rows for the same key+value.

**Acceptance.** An agent attempting to change a founder fact results in a pending proposal and
an unchanged fact.

---

## B4 — Per-engine context-file materialization (opt-in, worktree-local)

**Goal.** Solve context-file drift (CLAUDE.md vs AGENTS.md vs .cursorrules) by rendering one
canonical context into the file each engine natively reads — **only** into session worktrees,
never into repo-owned files.

**Depends on D1** (profiles supply the per-engine file name + wrapper).

**Policy.** Per-project setting `NUNCIO_CONTEXT_FILE_POLICY` = `none` (default) |
`worktree-local`. Under `worktree-local`, at worktree creation time (the task runner's existing
worktree setup step) nuncio writes the engine's local-override file — profile field
`contextFileName`, e.g. `CLAUDE.local.md` for Claude Code, `AGENTS.local.md` where supported —
containing: rendered facts (B2 renderer, same budget) + a pointer line
`Managed by nuncio — do not edit; edit facts in the nuncio UI.` The file is appended to
`.git/info/exclude` of the worktree (never the repo `.gitignore`).

**Hard rules.**
- If the target file already exists in the worktree (checked-in local override), nuncio writes
  nothing and logs a `status` event noting the skip — never merge, never overwrite.
- `none` policy or an engine whose profile has no `contextFileName` → no file, facts still
  arrive via B2 preamble (the two channels are redundant by design; preamble is the guarantee,
  the file is engine-idiomatic reinforcement).

**Module.** `apps/server/src/context/context-file.materializer.ts`, called from the worktree
provisioning path in the task runner.

**Tests.** Materializer spec against a tmp worktree: writes file + exclude entry under
`worktree-local`; skips existing file; `none` writes nothing; no profile file name → nothing.

**Acceptance.** A `worktree-local` project spawning a Claude Code task yields a worktree whose
`CLAUDE.local.md` holds the current facts, invisible to `git status`.

---

## B5 — `renderEventsSince` compact replay helper

**Goal.** The one sanctioned way to move a slice of another session's history: compact,
budgeted, lossy-by-design.

**Module** — `apps/server/src/context/events-compactor.ts`:

```ts
export function renderEventsSince(
  events: SessionEventDto[],   // caller supplies events.listSince(sessionId, seq)
  budgetBytes: number,         // default 4096
): string
```

Rendering rules (deterministic, unit-testable):
- Include: `user_message` (prefixed `**User:**`), final `assistant_message` texts
  (`**Assistant:**`, tail-truncated 512 B each), `tool_start` as one line
  `→ tool <name>(<primary path/arg>)` with no output, `verify_result` as
  `✔ verify passed` / `✘ verify failed: <first 200 B>`, `error` events, `task_completed`
  digests as their goal+status line.
- Exclude entirely: `assistant_delta`, `thinking_*`, `steer_queued`, `status`,
  `transcript_refreshed`, and tool outputs.
- Budget: newest-first retention (drop oldest lines first), header
  `## Session <id> since seq <n> (compacted)` plus `_(M earlier events dropped)_` marker.

**Consumers.** C1 `read_session` tool; the rung-1 verify-feedback loop may adopt it for
steer-with-failure-context later (out of scope here).

**Repository support.** `EventsRepository.listSince(sessionId, seq, limit)` if not already
present (the replay-by-seq path exists; expose a bounded variant).

**Tests.** Table test over a synthetic 30-event log: inclusion/exclusion per type, budget
eviction order, marker correctness, empty-slice → header only.

**Acceptance.** Compacting a real 200-event session stays under budget and reads as a coherent
timeline (manual dogfood check on one live session).
