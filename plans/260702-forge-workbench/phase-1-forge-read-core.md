# Phase 1 — Forge read core (provider interface + repo-scoped API)

**Server-only.** Extends `ForgeProvider` with read operations and normalized DTOs; adds the
repo-scoped controller. No UI change. Everything Phase 2–4 renders comes from here.

## New types (`forges/forges.types.ts`)

```ts
ForgeCapabilities {
  requestChanges: boolean;      // GH yes · GL no (approve/unapprove only)
  rebaseMerge: boolean;         // GH merge|squash|rebase · GL merge(+squash flag)
  mergeWhenChecksPass: boolean; // GL merge_when_pipeline_succeeds · GH auto-merge (defer)
  resolveThreads: boolean;      // both yes (GH via graphql-lite, D8)
  updateBranch: boolean;        // GH PUT /pulls/:n/update-branch · GL rebase endpoint
}
ForgePullRequestSummary { number; title; state; draft; author; sourceBranch; targetBranch;
  url; updatedAt; commentCount }
ForgePullRequestDetail extends ForgePullRequest { body; author; draft; sourceBranch;
  targetBranch; mergeable: 'mergeable'|'conflicts'|'blocked'|'unknown';
  reviewDecision: 'approved'|'changes_requested'|'review_required'|null;
  additions; deletions; changedFiles }
ForgeFileDiff { path; oldPath: string|null; status: 'added'|'modified'|'removed'|'renamed';
  additions; deletions; patch: string|null }   // null = binary/too large
ForgeComment { id; author; body; createdAt }
ForgeReviewThread { id; resolved: boolean|null; resolvable: boolean; path: string|null;
  line: number|null; outdated: boolean; comments: ForgeComment[] }
ForgeIssueSummary { number; title; state; author; labels: string[]; assignees: string[];
  commentCount; updatedAt; url }
ForgeIssueDetail extends ForgeIssueSummary { body; comments: ForgeComment[] }
```

## Provider methods (both providers; REST unless noted)

| Method | GitHub | GitLab |
|---|---|---|
| `capabilities()` | static | static |
| `listPullRequests(repo, {state})` | `GET /repos/{o}/{r}/pulls` | `GET /projects/:id/merge_requests` |
| `getPullRequestDetail(repo, n)` | `GET /pulls/{n}` (+ reviews aggregate → reviewDecision) | `GET /merge_requests/:iid` (`detailed_merge_status`) |
| `listPullRequestFiles(repo, n)` | `GET /pulls/{n}/files` | `GET /merge_requests/:iid/diffs` |
| `listReviewThreads(repo, n)` | **graphql-lite** `reviewThreads` (D8) | `GET /merge_requests/:iid/discussions` |
| `replyToThread(repo, n, threadId, body)` | `POST /pulls/{n}/comments` `in_reply_to` | `POST .../discussions/:id/notes` |
| `resolveThread(repo, threadId, resolved)` | **graphql-lite** `resolveReviewThread` | `PUT .../discussions/:id?resolved=` |
| `listIssues(repo, {state})` | `GET /repos/{o}/{r}/issues` (filter out `pull_request`) | `GET /projects/:id/issues` |
| `getIssue(repo, n)` | issue + `GET /issues/{n}/comments` | issue + `GET /issues/:iid/notes` |

GitLab `projects/:id` = URL-encoded `owner/repo`. GitLab MR `iid` maps to `number`.

## Repo-scoped routes (`forges/api/forge-repo.controller.ts`)

Project identified by `?path=<absolute repo path>` — same convention as
`GET /api/projects/branches?path=`. Facade resolves `path → GitService.remoteInfo → registry
provider by host` (logic already in `forges.service.ts`, extract as `resolveForRepo(path)`).

- `GET /api/forge/capabilities?path=` → `ForgeCapabilities & { provider, connected, authMethod }`
  — per D11 the flags encode (provider feature) × (current auth's ability); the UI disables
  what's false with a reason tooltip, never prompts re-auth
- `GET /api/forge/pulls?path=&state=` → `ForgePullRequestSummary[]`
- `GET /api/forge/pulls/:number?path=` → `ForgePullRequestDetail` (checks included)
- `GET /api/forge/pulls/:number/files?path=` → `ForgeFileDiff[]`
- `GET /api/forge/pulls/:number/threads?path=` → `ForgeReviewThread[]`
- `GET /api/forge/issues?path=&state=` → `ForgeIssueSummary[]`
- `GET /api/forge/issues/:number?path=` → `ForgeIssueDetail`

Session-scoped: extend `GET /api/sessions/:id/forge/pull-request` response to the detail shape
(keeps `pr-panel` on one fetch).

## Test plan (bun test, mocked fetch — existing provider-test pattern)

- Per provider: DTO mapping fixtures for each endpoint (real captured JSON, trimmed).
- GitHub: issues list filters out PRs; graphql-lite thread mapping incl. `isResolved`/`isOutdated`.
- GitLab: discussion → thread mapping (`resolvable`, position → path/line); iid↔number.
- Controller: 404 on non-git path; 409 when no provider connected for host.

## Changeset

`feat(server): forge read core — PR/MR list, detail, files, review threads, issues via normalized provider API`
