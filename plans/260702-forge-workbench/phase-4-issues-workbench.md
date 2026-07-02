# Phase 4 — Issues workbench + issue → session

Independent of Phases 2–3; needs only Phase 1 reads. This is where Nuncio beats the forge UI:
an issue is not just readable in-app — it becomes an agent session in one click.

## Server

- `addIssueComment(repo, n, body)` — GitHub `POST /issues/{n}/comments` (existing `addComment`
  already targets this endpoint — reuse); GitLab `POST /issues/:iid/notes` (MR notes and issue
  notes are different endpoints — split the GitLab impl).
- `updateIssueState(repo, n, state)` — PATCH `state` / GitLab `state_event: close|reopen`.
- `createIssue(repo, { title, body, labels? })` → `ForgeIssueSummary`.
- Routes: `POST /api/forge/issues/:number/comment`, `POST /api/forge/issues/:number/state`,
  `POST /api/forge/issues { title, body, labels }`.

## Web

- **`forge/issue-list.tsx`** — the **Issues** segment of the session SCM tab (D9), scoped to the
  session's project. `state=open` default, newest-updated first (D12); filter chips: assigned to
  me · created by me · label (client-side over the fetched page; `getCurrentUser` login from
  `GET /api/forges` status).
- **`forge/issue-detail.tsx`** — markdown body (`react-markdown`, existing), comment timeline,
  comment box, Close/Reopen button, labels/assignees badges; opens in-segment with a back
  affordance (same pattern as Repo PRs → pr-detail).
- **New issue** — small dialog (title + body) from list header.
- **Issue → session (the differentiator):** button on `issue-detail`:
  1. Prefills the new-session composer (home or grid empty slot) with the session's project
     path + prompt template:
     `Fix issue #<n>: <title>\n\n<body>\n\nIssue: <url>`.
  2. Session creation flows through the existing worktree/branch machinery
     (`nuncio/<id>-<slug>` branch), and the eventual PR body gets `Closes #<n>` so the forge
     auto-closes the issue on merge (`forges.service.openPullRequestForSession` body template).
  3. Store `issueNumber`/`issueUrl` on the session (same fields forge-plan Phase 4 webhooks
     write) so webhook-created and click-created sessions share one shape.

Relationship to webhooks (forge plan Phase 4): webhooks push labeled issues into sessions
automatically; this phase is the pull/manual path. Same session fields, same PR-body convention —
webhook phase becomes purely additive.

## Test plan

- Provider tests: GitLab issue-note vs MR-note endpoint split; GitHub create-issue mapping.
- `issue-list.spec.tsx` filters; `issue-detail.spec.tsx` comment post + close flow.
- E2E: issue → session → PR body contains `Closes #n` (assert via `openPullRequestForSession`
  unit test on the body template).

## Changeset

`feat: in-app issue triage — list, comment, close, create, and one-click issue → agent session`
