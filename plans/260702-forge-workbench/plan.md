# Forge Workbench — PR/MR review, merge, issues, fully in-app

**Status:** Implemented 2026-07-02 (all 4 phases, single pass) · extends `docs/git-forge-integration-plan.md` (Phases 1–5)
**Verified:** 628 server + 629 web tests green; real-browser pass against live GitHub data (oscarlehuu/nuncio) on the worktree-full instance — capabilities/PR list/detail/files/threads/issues read paths live, write paths (reply, resolve, review, merge, issue ops) unit-tested with fixture param mapping; no live writes made to the real repo.
**Thesis:** Today Nuncio can open a PR and watch its checks (`pr-panel.tsx`), but reviewing, merging,
and triaging issues still require github.com/gitlab.com. This plan closes that loop: read review
threads, reply, resolve, approve/request-changes, merge with method picker, and browse/act on
issues — all inside the app, for GitHub (gh) and GitLab (glab) behind the same `ForgeProvider`
interface. The killer move is **issue → session**: any issue becomes a one-click agent session in
the grid workbench.

## What already exists (do not rebuild)

- `ForgeProvider` interface + registry + base provider (`apps/server/src/forges/forges.types.ts:64`,
  `forges.registry.ts`, `forges.base-provider.ts`) — mirrors the agent-provider pattern.
- GitHub + GitLab providers with **PAT-or-CLI auth**: `resolveAuth()` falls back to `gh auth token`
  / `glab` token via `forges/cli-auth.ts`. The "gh và glab" story is already the token source;
  operations stay REST (see D11).
- Session-scoped PR flow: open PR, refresh state + checks, add comment
  (`forges/api/forges.controller.ts`, `forges.service.ts`).
- Local git review: status/diff/commit/push + `review-changes.tsx` UI in the SCM inspector tab.
- `remoteInfo(path)` → host/owner/repo parsing (`git/git.service.ts:475`) — the path→provider
  resolution seam every new route reuses.
- Webhook scaffolding (signature verify + event parse) from forge plan Phase 4.

## Architecture delta

```
apps/server/src/forges/
  forges.types.ts             EXTEND — summaries, detail, threads, file diffs, issues,
                              merge opts, ForgeCapabilities
  providers/github-forge.provider.ts   EXTEND — REST + graphql-lite (threads only, see D8)
  providers/gitlab-forge.provider.ts   EXTEND — REST (discussions API has resolved natively)
  forges.service.ts           EXTEND — repo-scoped facade (path → remoteInfo → provider)
  api/forges.controller.ts    EXTEND — session-scoped PR detail
  api/forge-repo.controller.ts NEW — repo-scoped routes, `?path=` convention
                              (same convention as GET /api/projects/branches?path=)

apps/web/src/components/
  diff-view.tsx               NEW — unified diff renderer extracted from review-changes.tsx
  forge/pr-list.tsx           NEW — PR/MR list for a project
  forge/pr-detail.tsx         NEW — tabs: Conversation · Files · Checks + merge bar
  forge/pr-thread.tsx         NEW — one review thread: comments, reply, resolve
  forge/pr-merge-bar.tsx      NEW — mergeable state, method picker, confirm
  forge/issue-list.tsx        NEW — issue list with filters
  forge/issue-detail.tsx      NEW — body + comments + actions + "Start session"
  session-detail.tsx          EXTEND — SCM tab segmented control:
                              Changes · PR · Repo PRs · Issues (D9)
```

Every provider difference is absorbed server-side into normalized DTOs; the web client never
branches on `github|gitlab`. Where a forge genuinely lacks a feature, the provider declares it in
`ForgeCapabilities` and the UI hides the control (e.g. GitLab has no "request changes" review
event, GitHub has no "merge when pipeline succeeds" toggle).

## Decisions (locked — founder, 2026-07-02)

**D8 — GitHub review threads via graphql-lite. ✅**
GitHub REST cannot read a thread's resolved state nor resolve a thread (GraphQL-only:
`reviewThreads` + `resolveReviewThread`). GitLab REST has both natively (discussions API).
A ~40-line `githubGraphql(query, vars)` helper inside the GitHub provider, used for exactly two
operations (list threads, resolve/unresolve); everything else stays REST. The gh CLI token works
for GraphQL unchanged.

**D9 — All forge UI lives in the session SCM tab. ✅ (no `/repo` route)**
The SCM inspector tab grows a segmented control: **Changes · PR · Repo PRs · Issues**.
"Changes" = existing `review-changes`; "PR" = this session's PR detail; "Repo PRs"/"Issues" =
repo-level browsing scoped to the session's project (drill into any PR/MR detail, act on issues).
One component set serves both the session's own PR and repo browsing. Trade-off accepted: triaging
a repo requires a session open in that project — consistent with the session-centric workbench.

**D10 — Merge always behind a confirm dialog. ✅**
Merge button enabled when `mergeable` + checks green; red/pending checks show the button disabled
with an explicit "override" checkbox in the confirm dialog. Never auto-merge in v1 (consistent
with forge-plan D4 manual-first). `deleteSourceBranch` default ON for `nuncio/*` branches, OFF
otherwise.

**D11 — CLI-first auth; operations over REST; unsupported actions get disabled, never a forced
re-auth. ✅**
The primary credential path is the gh/glab CLI token (`resolveAuth` already falls back to it when
no `GITHUB_TOKEN`/`GITLAB_TOKEN` is set — the founder sets none, so CLI is the live path). OAuth
is only ever considered for something the CLI token cannot support, and until then those actions
are simply **disabled in the UI** with a reason tooltip, not gated behind an auth prompt.
Concretely: the capabilities endpoint reports `authMethod` + per-action availability =
(provider feature) × (current auth's scope), and the UI renders unavailable actions disabled.
Operations themselves stay REST (no shelling to `gh pr view` — CLI-version drift, un-normalized
output, zero capability gain); the CLIs are the credential source, not the engine.

**D12 — Issue list defaults: `state=open`, newest-updated first. ✅**
Client-side filter chips (assigned to me · created by me · label). GitHub note: `/issues` REST
returns PRs too — provider must filter `pull_request` key out.

## Constraints

- Files stay under ~200 lines — split components as listed, extract `diff-view.tsx` before
  building on it.
- No new settings keys: reuses `GITHUB_TOKEN`/`GITLAB_TOKEN`/API-URL keys + CLI fallback.
- Rate budget: polling only while a forge view is visible (30s interval + refetch on focus, the
  existing `pr-panel` pattern). PAT budget 5000 req/h is ample; add ETag conditional requests in
  the base provider only if we ever see 403-rate-limit.
- Token scope: merge/review need `repo` (GitHub) / `api` (GitLab) scope — `gh`/`glab` CLI tokens
  have it by default; settings help-text documents it for PATs.
- Inline **new** comments on a specific diff line are deferred to Phase 4b (GitLab position
  objects need base/head/start SHA bookkeeping); replying to existing threads ships in Phase 2.

## Phases

| Phase | Focus | Plan |
|-------|-------|------|
| 1 | Provider + API read core: PR list/detail/files/threads, issues, capabilities | [phase-1-forge-read-core.md](./phase-1-forge-read-core.md) |
| 2 | Review UI: PR detail (threads/files/checks), reply, resolve, approve/request-changes | [phase-2-pr-review-ui.md](./phase-2-pr-review-ui.md) |
| 3 | Merge + PR actions: merge methods, delete branch, close/reopen, update-branch | [phase-3-merge-actions.md](./phase-3-merge-actions.md) |
| 4 | Issues workbench: list/detail/comment/state/create + **issue → session** | [phase-4-issues-workbench.md](./phase-4-issues-workbench.md) |
| 5 | Actions: workflow runs/pipelines, jobs + steps, log tails, re-run/cancel | [phase-5-actions.md](./phase-5-actions.md) |

**Post-ship refinements (founder, 2026-07-02):**
- **SWR cache** (`apps/web/src/lib/forge-cache.ts`): module-level stale-while-revalidate store
  behind `useForgeQuery(key, fetcher, {staleMs, pollMs, onError})`. Segment switches render cached
  data instantly; a background revalidation (mount-if-stale, window focus, poll) fetches updates
  and re-renders only when the payload actually changed (JSON-equality keeps the old reference).
  Inflight dedupe shares one request across subscribers; mutations call `refresh()` so every view
  of the same key (e.g. the session PR in Changes and the same PR opened from the PR list) updates
  together. All forge components ride this hook — no component owns its own fetch/interval logic.
- **Segment merge**: Changes now stacks local changes + the session's PR (the pre-D9 layout,
  restored deliberately); "Repo PRs" renamed to **PR**. Segments: Changes · PR · Issues · Actions.
  The retired `'pr'` segment id maps to `'changes'` when restoring persisted preferences.

Ordering rule: Phase 1 is pure server + types (parallel-safe with any UI work). Phase 2 delivers
the felt value ("xem review trong app"). Phase 3 is small once detail data exists. Phase 4 is
independent of 2–3 and can run in parallel after 1.

## Dev/test setup for this worktree

One `.claude/launch.json` config, **`worktree-dev`**: full stack from this worktree — API :3058 +
web http://localhost:5258 — with the **shared** data dir (worktree-local `.env` sets
`NUNCIO_DATA_DIR=$HOME/.nuncio/data`, the established worktree pattern). The worktree server runs
this branch's code (so the new `/api/forge/*` routes exist) while reading the same
sessions/projects/settings as the main instance on :3000/5173; SQLite is in WAL mode
(`database.service.ts`), which tolerates the two server processes.

Earlier web-only setup (5258 proxying the main :3000 backend) was dropped: the main checkout's
server predates the forge routes, so Repo PRs/Issues 404'd through it.
