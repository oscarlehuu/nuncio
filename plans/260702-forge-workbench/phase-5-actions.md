# Phase 5 — Actions: workflow runs, jobs, logs, re-run/cancel

**Status:** Implemented 2026-07-02. Added on founder request after Phases 1–4 shipped.

CI visibility without opening the forge: an **Actions** segment in the SCM tab lists GitHub
Actions runs / GitLab pipelines, drills into a run's jobs (with per-step status on GitHub),
shows a failed job's log tail, and can re-run or cancel.

## Server

- Types: `ForgeWorkflowRun` / `ForgeWorkflowJob` / `ForgeWorkflowStep` / `ForgeJobLog`;
  normalized lifecycle `queued → running → completed` + conclusion.
- Provider methods (in a dedicated `*-forge.actions.ts` class between core and provider):

| Method | GitHub | GitLab |
|---|---|---|
| `listWorkflowRuns(repo, {branch})` | `GET /actions/runs?branch=` | `GET /pipelines?ref=` |
| `getWorkflowRunJobs(repo, runId)` | `GET /actions/runs/:id/jobs` (steps) | `GET /pipelines/:id/jobs` (no steps; name = `stage: job`) |
| `rerunWorkflowRun(repo, runId, {failedOnly})` | `rerun` / `rerun-failed-jobs` | `retry` (failed-only is implicit) |
| `cancelWorkflowRun(repo, runId)` | `cancel` | `cancel` |
| `getJobLog(repo, jobId)` | `GET /actions/jobs/:id/logs` (follows blob redirect) | `GET /jobs/:id/trace` |

- `BaseForgeProvider.requestText` (plain-text fetch) + `tailLog` (strip ANSI, keep last 64KB on a
  line boundary, `truncated` flag).
- Capability `rerunFailedOnly` (GitHub true, GitLab false — its retry already means that).
- Routes: `GET /api/forge/runs?path=&branch=`, `GET /api/forge/runs/:id/jobs`,
  `POST /api/forge/runs/:id/rerun { failedOnly }`, `POST /api/forge/runs/:id/cancel`,
  `GET /api/forge/jobs/:id/log`.

## Web

- `forge/run-list.tsx` — chips `all · <session branch>`, status icons, duration + age, 30s poll.
- `forge/run-detail.tsx` — header + Re-run / Re-run-failed (capability-gated) / Cancel (while
  live), jobs with step breakdown, on-demand log tail in a mono scroll box, 15s poll.
- SCM segmented control gains **Actions** (`ScmSegment` union + persistence).

## Verified

- Unit: run/job/step mapping both providers, rerun/cancel/log param mapping, ANSI-strip +
  line-boundary tail (`forge-actions.spec.ts`), RunDetail interaction spec.
- Live read-only against oscarlehuu/nuncio: 30 real runs listed, failed `Release #20` drilled to
  its failed step, real 16KB job log fetched through the blob redirect. Re-run/cancel not fired
  against the real repo (unit-tested only).
