# Phase 2 — PR/MR review UI (threads, files, submit review)

**The felt-value phase:** read a whole review in-app, reply, resolve, approve — never open the
forge website. Depends on Phase 1 data.

## Server additions

- `submitReview(repo, n, { event: 'approve'|'request_changes'|'comment', body? })`
  - GitHub: `POST /pulls/{n}/reviews` (`APPROVE|REQUEST_CHANGES|COMMENT`)
  - GitLab: approve → `POST /merge_requests/:iid/approve`; comment → note;
    `request_changes` unsupported → capability-gated off in UI
- Routes: `POST /api/forge/pulls/:number/review { event, body }`,
  `POST /api/forge/pulls/:number/threads/:threadId/reply { body }`,
  `POST /api/forge/pulls/:number/threads/:threadId/resolve { resolved }`

## Web

1. **Extract `diff-view.tsx`** from `review-changes.tsx` (unified-diff renderer: hunk headers,
   +/- coloring, mono font). `review-changes` and PR files tab both consume it. No behavior change
   to review-changes — its spec must stay green.
2. **`forge/pr-detail.tsx`** — header (title, author, source→target, state/draft badge,
   reviewDecision badge) + tabs:
   - **Conversation:** PR body, then `pr-thread.tsx` per thread (resolved threads collapsed),
     reply box per thread, resolve/unresolve toggle (capability-gated), plus top-level comment box
     (existing `addComment`).
   - **Files:** `ForgeFileDiff[]` list, lazy-expand per file into `diff-view`; `patch: null` →
     "binary or too large" row. Badge per file when a thread anchors to it (`thread.path`).
   - **Checks:** existing checks list from `pr-panel`, moved here unchanged.
3. **Review bar:** Approve · Request changes (GitHub only) · Comment — one button group posting
   `submitReview`; disabled while pending; toast on success/failure (sonner, existing pattern).
4. **Mounting (D9 — all inside the session SCM tab):** the SCM tab gets a segmented control
   **Changes · PR · Repo PRs · Issues** (persisted alongside the inspector tab in
   `inspector-preference.ts`).
   - **Changes** — existing `review-changes`, untouched.
   - **PR** — `pr-panel.tsx` becomes open-PR button + embedded `pr-detail` once a PR exists
     (session-scoped fetch keeps working).
   - **Repo PRs** — `forge/pr-list.tsx` scoped to the session's project path (state filter
     chips: open/merged/closed); selecting a row swaps the segment body to that PR's
     `pr-detail` with a back affordance.
   - (**Issues** segment ships in Phase 4.)
5. **Freshness:** refetch detail/threads on window focus + 30s interval while visible (reuse
   `pr-panel` polling helper).

## Test plan

- `pr-detail.spec.tsx`: renders threads from fixture; resolved collapsed; reply posts and
  optimistically appends; capability gating hides Request-changes for gitlab fixture.
- `diff-view.spec.tsx`: hunk parsing/coloring snapshot; `review-changes.spec.tsx` unchanged.
- Real-browser pass (per memory rule): drive Chrome against http://localhost:5258 on a repo with
  a live PR; verify threads render, reply lands on the forge (then delete test comment).

## Changeset

`feat(web): in-app PR/MR review — threads, replies, resolve, file diffs, approve/request-changes`
