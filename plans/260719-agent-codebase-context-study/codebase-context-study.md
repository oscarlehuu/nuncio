# Agent codebase understanding — git integration audit + Codex CLI / Grok Build study (2026-07-19)

Grounding: origin/dev @ `7b3fa60a` (engine rail, capture_evidence, eval:extract merged).
Sources: full survey of `apps/server/src/git|forges|sessions|agents/pi-engine|crew|orchestration`,
`docs/pi-engine.md`, `openai/codex` source (`agents_md.rs`, `project_doc.rs`, `compact.rs`),
`xai-org/grok-build` public tree + leaked runtime prompt + harness write-ups.
Companion studies: `plans/260718-nuncio-engine-harness-study/harness-gap-study.md`,
`plans/260719-engine-shell-and-compaction/plan.md` (compaction Track B — NOT re-litigated here).

## TL;DR recommendation

**The cheapest large win is not an index or a repo map — it is (1) a bounded git/workspace
snapshot injected at session start, (2) making the existing project-facts store compound
automatically across sessions (Grok Build's memory lesson), and (3) an `/init`-style AGENTS.md
generator so every future session starts pre-briefed (Codex's highest-leverage lesson).**
Both reference harnesses deliberately ship **no codebase index** — they are grep-first and win on
what they inject deterministically and what they persist across sessions. Nuncio already owns all
the storage and injection plumbing; the gap is wiring and defaults, not new architecture.

Trade-off named: we spend a small fixed token budget (~1–2 KB per session) on deterministic
context that the agent would otherwise re-derive with 5–15 exploratory tool calls per session
(`ls`, `git status`, `git log`, README skims — each a full model round-trip on every fresh
session). We give up nothing: no index to build/maintain/invalidate, no provider-specific code.

---

## 1. What Nuncio has today (audit)

### 1.1 Git integration — mature, with hygiene gaps

Shipped (all on dev): project discovery + branch listing + clone (`git/`), per-session worktrees
(`nuncio/<sessionId>-<slug>` under `~/.nuncio/workspaces/<id>`), session git API
(`/api/sessions/:id/git/*`: status/diff/sync/blame/history/commit/push/pull), structured session
diff + hunk comments → steer, full forge layer (`forges/`: GitHub/GitLab PRs, issues, actions,
webhooks, PR-adoption `POST /api/sessions/from-pr`, auto-close-on-merge with safe worktree
removal), Crew frozen-HEAD worktrees + checkpoints + boundary inspection.

Gaps found (housekeeping backlog, not blockers):

| Gap | Detail |
|---|---|
| No worktree cleanup on manual archive/delete | Only the PR-merge webhook path calls `removeWorktreeIfSafe`; `nuncio/*` branches accumulate forever |
| `cleanupPolicy` unenforced | `after-review`/`manual`/`never` stored on task rows; no code acts on it |
| No branch deletion API | Even after worktree removal the branch ref stays |
| Local mode ignores `baseBranch` | Metadata only; agent runs on whatever HEAD the repo has (documented, but surprises users) |
| Crew worktrees never removed | Retained after terminal runs by design; no eventual GC |

### 1.2 What the agent actually "knows" at session start

For a fresh solo Nuncio Engine (Pi) session:

| Injected | Source | Budget |
|---|---|---|
| Project facts (user-curated) | `renderContextFacts` in **user preamble** AND `buildNuncioContext` in **Pi system append** — **the same facts are sent twice** | 4 KB × 2 |
| Handoff brief (subagents/tasks only) | `composeSessionPreamble` / `nuncio-context` | included above |
| External memory index (Claude/Codex files, read-only) | `external-memories.ts` + `read_external_memory` tool | 12 KB |
| Runtime manifest + mode overlay | `renderRuntimeInstructions` | small |
| Repo `AGENTS.md` + personal `~/.pi/agent/AGENTS.md` | **Pi SDK loader**, not Nuncio (solo only; policy sessions `noContextFiles`) | unbounded (SDK) |

**Not injected — the agent must burn tool calls to learn:** current branch, HEAD, dirty state,
recent commits, file tree / top-level layout, README. `buildWorkspaceSnapshot`
(`orchestration/workspace-snapshot.ts`: branch, headSha, dirtyFiles≤20, diffStat≤1 KB) **already
exists** but is only attached to subagent handoff briefs — a plain `POST /api/sessions` gets none
of it. There is no repo map, no codebase index, and no server-side README/AGENTS.md read.

Memory write path: `nuncio_record_project_fact` exists but only under
`NUNCIO_ORCHESTRATION_TOOLS=read-write` (default **off**). Nothing captures durable knowledge at
session end. So today, understanding does **not compound**: session N+1 re-explores everything
session N learned, minus whatever the user hand-typed into facts.

---

## 2. What the references do (and deliberately don't)

### 2.1 Codex CLI (`openai/codex`, Rust)

- **No index, no embeddings.** Discovery is ripgrep-first (ships `rg`, respects `.gitignore`).
  Structural indexing is explicitly left to external MCP servers (open issue #5181).
- **AGENTS.md is the whole context strategy.** Discovery chain: `~/.codex/AGENTS.override.md` →
  `~/.codex/AGENTS.md` → every `AGENTS.md` from repo root down to cwd, concatenated in order,
  deeper wins; capped by `project_doc_max_bytes` (32 KiB default); fallback filenames
  configurable. Injected once as `<user_instructions>`.
- **AGENTS.md survives compaction as canonical initial context** — `compact.rs`
  `build_compacted_history` re-inserts user instructions + environment context right before the
  last real user message. Project knowledge is never summarized away.
- **`environment_context` block** injected per session/turn: cwd, sandbox mode, approval policy,
  network access, shell. Deterministic, tiny, and the model never has to ask.
- **`/init` command** scaffolds an AGENTS.md by scanning the repo — OpenAI's own answer to
  "highest-leverage single action before using Codex".

### 2.2 Grok Build (`xai-org/grok-build`, Rust)

- **Also no index** — just-in-time context via tools; `xai-grok-workspace` abstracts
  filesystem/VCS/checkpoints; `xai-fast-worktree` gives parallel subagents cheap git worktrees
  (validates Nuncio's worktree design).
- **AGENTS.md family** (`AGENTS.md`, `Agents.md`, `Claude.md`, `AGENT.md`, anywhere in the repo,
  root→cwd, deeper wins) injected via `<system-reminder>`; system prompt assembled from a
  template + runtime context (AGENTS.md trees, personas, memory hints, OS/cwd/date,
  primary-vs-subagent).
- **The differentiator: persistent cross-session memory.** Workspace-scoped
  `~/.grok/memory/<workspace-slug>/MEMORY.md` + global `MEMORY.md`; `memory_search` /
  `memory_get` tools; **memory is auto-saved at end of each session** ("technical context,
  debugging techniques, user preferences, decisions, problem/solution pairs"); the prompt tells
  the model to search memory proactively. This is exactly "understand the codebase cheaper":
  exploration cost is paid once and amortized over every future session.
- **Skills manifest** injected as name + one-line description + path (progressive disclosure —
  read the file only when needed). Full-replace compaction ~85% with reseed rules (already
  covered by our Track B plan; out of scope here).

### 2.3 Convergent lesson

Neither harness builds a repo map or semantic index. Both spend their budget on:
**(a) deterministic environment/git context injected up front, (b) AGENTS.md as the canonical
repo brief with a hard byte cap, (c) durable per-workspace memory (Grok) so knowledge
compounds.** Aider-style ranked repo maps exist in the ecosystem but neither frontier harness
adopted them — grep-first + good priors won. Nuncio should not build an index either (YAGNI; and
an index is un-ownable across four providers).

---

## 3. Recommendations (ordered by impact ÷ cost)

### P0 — Stop double-injecting facts (bug-sized fix)

The same facts block is rendered into the user preamble (`renderProjectFacts`) **and** the Pi
system append (`buildNuncioContext`) with different headers. Pick one home — the system append
(survives compaction better, per Codex's canonical-initial-context lesson) — and drop the user
preamble copy for the Pi engine (keep it for providers with no system-append seam). Saves up to
4 KB on every Pi session, zero behavior loss. TDD: spec asserting facts appear exactly once in
the composed model input.

### P1 — Workspace snapshot in every git-bound session (the Codex `environment_context` move)

Extend the existing `buildWorkspaceSnapshot` and inject a bounded (~1 KB) block into every
session that has a git cwd (solo + subagent, all providers — it is provider-neutral text in the
shared preamble/system path):

```
## Workspace
repo: <projectPath>  branch: <branch> (base: <baseBranch>)  head: <sha8>
dirty: <n files / clean>
recent: <last 3 subject lines>
top-level: <first ~30 entries of git ls-files depth-1, dirs marked>
```

Nothing here requires new plumbing: snapshot exists, `composeSessionPreamble` exists, budgets
and truncation conventions exist (`fitContextBudget`). Kill-switch env like the facts inject.
This removes the standard cold-open tool-call tax (`git status`, `git log`, `ls`) — the most
common first 3–6 round-trips of every recorded session — and grounds the model on the *worktree*
branch instead of guessing. Explicitly **not** a repo map: one level, hard cap, deterministic.
Eval: extract a recorded exploration-heavy session, A/B tool-call count + tokens-to-first-edit.

### P2 — Make project knowledge compound (the Grok Build memory move)

Nuncio already has the store (context-facts, pinned-first, budgeted, injected, eval-covered by
`use-project-facts` / `record-discovered-fact`). What's missing is the write loop:

1. Enable `nuncio_record_project_fact` for solo Engine sessions by default (it is currently
   locked behind `NUNCIO_ORCHESTRATION_TOOLS=read-write`, default off) — with the existing
   per-fact 1 KB cap and pinning rules.
2. Add an end-of-session distillation hook on the engine rail (`engine-extension.ts` — the rail
   from the 260718 study exists precisely for this): when a session reaches IDLE after a
   substantive run, prompt-cheaply extract 0–3 durable, context-free facts (Grok's rubric:
   conventions, commands, decisions, problem/solution pairs) and upsert them with dedupe against
   existing facts. Facts remain user-visible/editable in the existing `/api/context-facts` UI —
   Nuncio's version of `MEMORY.md` with a UI, which is *better* than Grok's opaque file.
3. Prompt nudge in the runtime manifest: "search/record project facts proactively" (Grok's
   memory section wording is a good template).

This is the "tiết kiệm" lever: the second session on a repo starts where the first left off.

### P3 — `/init` for Nuncio: one-tap AGENTS.md generator

Codex's own positioning: writing AGENTS.md is the single highest-leverage pre-task action. Most
target repos of Nuncio users won't have one. Ship a session template / home-screen action
"Generate AGENTS.md for this project" that runs a canned Engine prompt (scan → draft →
`AskUserQuestion` review → write file, PR-able via the existing forge layer). Zero new
server surface — it is a prompt + maybe a template row. The repo AGENTS.md then feeds every
provider natively (Pi loader, Codex CLI, Claude, Cursor all discover it themselves), which is
the only context mechanism that is automatically **cross-provider**.

### P4 — Git hygiene backlog (do opportunistically)

Archive-time `removeWorktreeIfSafe` (reuse the webhook path's clean+no-unpushed guards) +
branch-ref deletion; enforce or delete `cleanupPolicy`; surface "this local-mode session is not
on `baseBranch`" in the UI. None of these block P0–P3.

### Explicit non-goals

- **No codebase index / embeddings / repo map service.** Both references refused it; it fights
  the four-provider abstraction; grep-first + P1/P2/P3 covers the need at ~zero maintenance.
  If a power user wants structural navigation, MCP is the escape hatch (Codex's answer too).
- **No compaction changes here** — Track B (`260719-engine-shell-and-compaction`) already owns
  that; P0's "facts live in system append" choice feeds its survivors design.
- **No per-provider context code.** P1–P3 ride shared seams (preamble, facts store, rail,
  session templates).

## Proposed phase seeds (if approved)

| # | Slice | Size |
|---|---|---|
| 1 | P0 dedupe + spec | XS — `sessions.service.ts`, `pi-agent.provider.ts` specs |
| 2 | P1 snapshot inject + eval A/B | S — `workspace-snapshot.ts`, `session-preamble.ts`, one eval task |
| 3 | P2 fact tool default-on + rail distillation hook | M — `orchestration-tools`, `engine-extension.ts`, dedupe logic |
| 4 | P3 AGENTS.md generator template | S — template + prompt, forge PR optional |
| 5 | P4 hygiene items | S each, independent |

## Unresolved questions

1. P2 distillation model/cost: reuse session model vs. cheap fixed model (`claude-sonnet-4-6`
   via cliproxyapi, same as Track B summarizer)? Recommend the cheap fixed model.
2. Should P1 snapshot also go to Crew member envelopes? Envelope already carries `fullHead`;
   adding dirty/top-level may conflict with the hermetic-context philosophy — defer.
3. Auto-captured facts: same table as user facts with a `source=agent` column, or separate
   store? Recommend same table + source column so the existing UI/injection/budget applies.
