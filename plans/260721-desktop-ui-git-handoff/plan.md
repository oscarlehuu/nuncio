# Desktop UI polish + Git controls + Cross-engine handoff — Investigation & Proposal

> 2026-07-21. Investigation only — nothing implemented. Three asks from Oscar:
> (1) desktop UI đẹp hơn, giống Synara/Cursor; (2) richer git buttons like Codex/Cursor/Devin/Synara;
> (3) hand off a task from one engine to another.
>
> Grounded in: 3 repo-recon reports (findings docs 01–03), a source-level study of the
> open-source Synara app (04-synara-reference.md), and web research on Codex/Cursor/Devin
> (competitor notes inside each doc). Synara clone lives in the session scratchpad (not committed).

## Headline findings

1. **The Cursor retheme is already done.** Commit `b7faf994` landed the exact Cursor tokens in
   `apps/web/src/index.css` + `packages/core/src/design-tokens.ts`. What makes nuncio feel less
   polished than Cursor/Synara is not color — it is (a) the **native Electron title bar** (both
   competitors use `hiddenInset`/frameless integrated chrome) and (b) ~70 small consistency
   violations (arbitrary px font sizes, hardcoded amber/emerald, off-ladder shadows).
2. **Git integration is ~70% built server-side but under-exposed in UI.** Status/diff/commit/push/
   pull/PR-create/PR-merge/PR-review/checks/issues/actions all have endpoints and forge providers
   (GitHub + GitLab, CLI-first auth). But: the only Commit UI (`review-changes.tsx`) is **not
   mounted anywhere**, the session header shows a bare branch chip, session rows have no
   +adds/−dels, and there is no stacked "Commit & push & PR" action. Competitors converged on a
   **header git split-button + task-row diff-stat grammar**; nuncio has the plumbing to match with
   mostly frontend work.
3. **Cross-engine handoff is ~80% plumbed and Synara proves the design.** Nuncio already has the
   compactor (`renderEventsSince`), handoff-brief renderer, workspace snapshot, `prior_session_id`
   lineage, engine routing, and a `contextBrief` preamble choke point. Synara (open source, same
   product category) ships exactly this feature as a header "Hand off" menu: fresh target-engine
   session + imported transcript + one-shot budgeted `<handoff_context>` injection on the first
   native turn + same branch/worktree. The missing nuncio piece is one endpoint + one menu.

## Proposed program (3 tracks, independently shippable)

### Track A — Desktop chrome & consistency (UI "đẹp hơn")
- **A1 Integrated title bar (biggest visual jump).** macOS `titleBarStyle:'hiddenInset'` +
  `trafficLightPosition` aligned to a shared header-height constant; CSS drag region on the web
  header with `no-drag` on the action cluster; frameless + custom window buttons on Windows.
  Mirror Synara's single-source-of-truth `desktopChrome.ts` trick (constant shared by main +
  renderer) to avoid 1px drift. Optional phase 2: macOS vibrancy `under-window` for the sidebar.
- **A2 Consistency sweep (mechanical, high leverage):** 57× `text-[NNpx]` → `text-ui*` scale;
  9× hardcoded amber/emerald → `--status-warning/success`; 5× legacy `shadow-sm/md/lg` →
  `shadow-e*` ladder; fix theme-blind `ui/switch.tsx` (bg-white) + `model-effort-slider.tsx`
  (ring-black) thumbs.
- **A3 Polish patterns borrowed from Synara:** worktree-setup progress stepper in the transcript
  (server already runs createWorktree; surface stages), staged progress toast for long git
  actions, empty-state hero for new sessions.
- **Open decision (Oscar):** elevation direction — `index.css` preaches flat-with-hairline, but
  session tiles/composers use `shadow-e1/e2 + surface-lit + hover-lift`. Keep the "hero surfaces
  lifted" exception, or go strict-flat like Cursor?

### Track B — Git controls ("thêm nút")
Ordered by value/effort:
- **B1 Mount the Commit flow.** `SessionChangesPanel` gets a Commit section (message box +
  button); endpoint `POST /sessions/:id/git/commit` already exists. Rescue or fold in the
  orphaned `review-changes.tsx`. (Days, not weeks.)
- **B2 Header git split-button** (Synara `GitActionsControl` pattern): quick action + dropdown —
  Commit / Commit & push / Push / Create PR / Commit & push & PR — with staged progress toast.
  Server gets one `runStackedAction`-style orchestration on top of existing git.service methods.
- **B3 AI commit message + PR title/body** generation (Synara uses a cheap model; nuncio can
  route through an available engine). Prefill, never auto-send.
- **B4 Task-row grammar:** +adds/−dels + dirty badge on session tiles/rows + PR-state chip
  (Codex-web convention). Needs a cheap per-session change-stat (reuse `hasChanges` heartbeat →
  extend to cached diffstat, pushed over the existing WS relay).
- **B5 Live SCM panel** — subscribe instead of fetch-on-mount (Synara `GitStatusBroadcaster`
  equivalent).
- **B6 PR review inbox** — cross-project PR list route (Synara v0.5.4 / Codex "PR Chat"); nuncio
  already has per-repo `forge/pr-list` + full PR detail, so this is mostly a new route + grouping.
- **B7 Later:** selective staging (server does only `git add -A` today), conflict-resolution UI
  (today display-only), local↔worktree environment handoff (Synara `gitHandoffOperations`), and
  an "apply worktree → main checkout" local merge path (today the only path is push→PR→merge).

### Track C — Cross-engine handoff ("Hand off to <engine>")
- **C1 Server:** `POST /api/sessions/:id/handoff-to { provider, model? }` → compose context pack
  = `renderEventsSince(events, budget)` + `buildWorkspaceSnapshot(worktree)` → `SessionsService.
  create({ provider, workspace/worktreePath/branch = source's, contextBrief = pack,
  priorSessionId: source.id })`. All ingredients exist; only the composition route is new.
  Adopt Synara's guards: target-availability check first; block re-handoff until the new session
  has ≥1 native turn; inject the pack once (nuncio's `composeSessionPreamble` already does
  one-shot-at-create, simpler than Synara's first-turn bootstrap).
- **C2 Worktree co-ownership contract:** source → `PAUSED/IDLE` marked "handed off", successor
  owns the worktree; define cleanup ownership (today two sessions on one worktree is undefined).
- **C3 UI:** "Hand off" menu in the session-detail header (next to model switch) listing
  available engines with brand icons + capability-gap notice; source→target badge on the new
  session; lineage chip already exists (`prior_session_id` + `GET /sessions/:id/lineage`).
- **C4 Also cheap:** the subagents panel already has `onChangeModel` (re-route a held task to a
  different engine) — surface that same engine-picker on the task inbox for consistency.

## Suggested order

B1 → C1+C3 (the flagship differentiator; small because plumbing exists) → A1 (visual jump) →
B2+B3 → A2 → B4/B5 → B6 → A3 → B7. Tracks are independent; A2 is safe filler anytime.

## Decisions needed from Oscar

1. **Elevation:** keep lifted hero surfaces (tiles/composers) or strict-flat per Cursor?
2. **Title bar scope:** macOS-only `hiddenInset` first (recommended), or macOS+Windows frameless
   in one go?
3. **Handoff transcript size:** Synara budgets ~32KB (last 6 messages verbatim + older summarized).
   Nuncio's `renderEventsSince` is byte-budgeted already — same ballpark OK?
4. **Priority between tracks** if not the suggested order.
