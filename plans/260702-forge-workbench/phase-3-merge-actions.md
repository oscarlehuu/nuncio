# Phase 3 — Merge + PR actions

Small phase once Phase 1 detail data exists. Implements D10 safety policy.

## Server

- `mergePullRequest(repo, n, { method: 'merge'|'squash'|'rebase', deleteSourceBranch?,
  commitTitle?, commitMessage? })` → `{ merged, sha, message }`
  - GitHub: `PUT /pulls/{n}/merge { merge_method, commit_title, commit_message }`;
    405/409 mapped to a typed "not mergeable" error (surface reason, don't retry).
  - GitLab: `PUT /merge_requests/:iid/merge { squash, should_remove_source_branch }`;
    `rebase` method capability-gated off.
  - Delete branch: GitHub separate `DELETE /git/refs/heads/{branch}` after merge; GitLab flag.
- `closePullRequest(repo, n)` / `reopenPullRequest(repo, n)` — PATCH state / MR state_event.
- `updateBranch(repo, n)` — GitHub `PUT /pulls/{n}/update-branch`; GitLab
  `PUT /merge_requests/:iid/rebase` (capability-gated).
- Routes: `POST /api/forge/pulls/:number/merge`, `POST /api/forge/pulls/:number/state
  { state: 'open'|'closed' }`, `POST /api/forge/pulls/:number/update-branch`.
- After a session's own PR merges: update session forge fields
  (`pullRequestState='merged'`, `forgeStatus='merged'`) via existing `updateForgeState`.

## Web — `forge/pr-merge-bar.tsx`

State machine off `ForgePullRequestDetail`:

| Condition | Bar |
|---|---|
| `mergeable` + checks green (+ approved if required) | Merge button enabled, method dropdown (capability + repo-allowed methods) |
| checks pending/failing | Button disabled → confirm dialog offers explicit override checkbox (D10) |
| `conflicts` | "Update branch" button (capability-gated) + hint |
| `blocked` (branch protection) | Reason text, no button |
| merged/closed | State badge + "Delete branch" if source still exists |

- Confirm dialog always (radix `dialog.tsx`): method, `deleteSourceBranch` toggle (default ON for
  `nuncio/*` branches), commit title editable for squash.
- After merge: refetch detail; if this is the session's PR, session footer badge flips to merged.

## Test plan

- Provider tests: merge param mapping per method; 405-conflict → typed error fixture.
- `pr-merge-bar.spec.tsx`: each table row above renders the right control set; override path
  requires checkbox before Merge enables.
- Real-browser pass on a throwaway repo PR: merge with squash + delete branch; verify session
  badge flips.

## Changeset

`feat: in-app PR/MR merge with method picker, checks gating, and branch cleanup`
