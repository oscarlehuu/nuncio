# Findings 02 — Git + forge integration current state vs competitors

## What exists (server)

`apps/server/src/git/git.service.ts` (Bun.spawn git, 1032 lines): listProjects/listBranches
(fetch-prune TTL 60s), createWorktree (`nuncio/<id>-<slug>`), status, diff (incl. untracked +
base-ref + worktree diff base), stageAll (`git add -A` only), commit, push
(`--force-with-lease`), pull, branchSync/unpushedCommits, stash/blame/history, remoteInfo,
removeWorktreeIfSafe (refuses dirty/unpushed), hasChanges (cheap dirty probe).

Routes:
- `GET/POST /api/projects*` — projects, branches, recent, clone.
- `/api/sessions/:id/git/*` (`git-session.controller.ts`) — status, sync, unpushed, diff,
  commit-diff, stash, blame, history, pull, commit (auto stageAll), push.
- `/api/sessions/:id/diff` (`session-diff.controller.ts`) — structured hunks, phone-capped;
  `POST /comment` turns a hunk comment into a **steer** to the running agent.
- `/api/forge/*` (`forge-repo.controller`) — PR list/detail/files/threads/comments,
  reply/resolve/review/comment/**merge** (squash/merge/rebase, delete-branch,
  merge-when-checks-pass)/state/update-branch; Actions runs/jobs/logs/rerun/cancel; issues CRUD.
- `/api/sessions/:id/forge/pull-request` — open PR for session, refresh, comment.
- `POST /api/sessions/from-pr` — adopt an existing PR into a new worktree session.
- Forge providers: GitHub (REST+GraphQL direct) + GitLab; **auth CLI-first** (`gh auth token` /
  `glab`), capabilities carry `connected/authMethod`, unsupported → disabled-with-reason
  (ADR-005). Webhooks incl. PR-lifecycle worktree reclaim (merged/closed → safe worktree removal).

## What exists (web)

- Create-time: `project-picker`, `branch-picker` (base branch only), `workspace-mode-picker`
  (local/worktree).
- Session header: **branch-name chip only** (`session-detail.tsx:1022`) — no dirty/ahead-behind.
- SCM inspector `forge/scm-panel.tsx`: Changes / PR / Issues / Actions.
  - Changes = `session-changes-panel.tsx`: branch strip w/ **Push** + **Pull** buttons,
    ahead/behind arrows, conflicts list (display-only), outgoing/incoming commits, stash,
    history, changed files w/ +/− and per-hunk **comment→steer**, blame. Fetch-on-mount, no
    polling.
  - `pr-panel.tsx`: **Open Pull Request** (IDLE + branch gated), PR state + checks; then full
    `forge/pr-detail` (merge bar, review bar approve/request-changes/comment, files w/ DiffView,
    threads), `pr-open-session-button` (adopt PR).
- Diff viewer is custom (`diff-view.tsx`); server pre-parses hunks. No diff2html/monaco.
- **Dead code:** `review-changes.tsx` — the only real Commit UI (message + commitSession +
  per-file diffs) — is **not mounted anywhere** (spec-only reference). Shipping UI has **no
  commit button**.

## Per-session signals

No persisted dirty flag/changed-count on `SessionDto`; no WS push or polling of git status —
panels fetch on mount. `hasChanges` heartbeat exists but only feeds the attention/fleet anomaly
collector. Orchestration computes diffstat snapshots for prompts/digests, not for the sidebar.

## Gap table vs Codex desktop / Cursor / Devin / Synara

| Capability | nuncio | competitors |
|---|---|---|
| Per-session diff view | ✅ structured hunks | tier-2 standard everywhere |
| Push / Pull buttons | ✅ branch strip | ✅ |
| Commit UI | ❌ endpoint exists, UI unmounted | ✅ all four |
| Stacked action (commit→push→PR one click) | ❌ | Synara `GitStackedAction`, Codex desktop |
| AI commit msg / PR title+body | ❌ | Synara `TextGeneration` (gpt-5.4-mini) |
| Selective staging / per-chunk stage-revert | ❌ (`add -A` only) | Codex desktop app |
| Branch switch on live session | ❌ | Synara BranchToolbar |
| +adds/−dels on task rows | ❌ | Codex web grammar: title·repo·branch·±stat·status |
| PR state chip on rows/tiles | ❌ (detail only) | Codex, Cursor dashboard |
| Live status push | ❌ | Synara GitStatusBroadcaster |
| PR review inbox (cross-project) | ❌ (per-repo list exists) | Synara v0.5.4, Codex "PR Chat" |
| Conflict resolution | display-only | mostly weak everywhere (parity ok) |
| Worktree setup progress UI | ❌ | Synara stepper w/ shimmer |
| Apply worktree→main locally | ❌ (push→PR→merge only) | Cursor "Apply" merges worktree |
| Verification artifacts on PR (screenshots/logs) | ❌ | Cursor cloud agents |

Devin note: fewest buttons of all — its git story is "bot contributor auto-pushes branches,
opens PRs from your template, responds when tagged"; differentiators are the live Planner pane
and machine snapshots, both orthogonal to this track.
