---
"nuncio": minor
---

Added rung 3: **Attention**. Nuncio now gives you one ranked **Inbox** for everything that needs you — provider approvals, stuck verify loops, broken Autopilot loops, PRs waiting for review, and fleet anomalies — with a sidebar badge, ack to say "seen" without clearing the work, and dismiss/resolve when you want to override it. A new heartbeat keeps that queue honest in the background: local self-checks catch expired forge credentials and zombie sessions, fleet reconciliation sweeps collectors on a cadence, and morning/evening digests arrive by push with a matching in-app briefing so the phone tells you what happened while you were away.

The app keeps the fleet health fold as a data layer for future project pages, while Home stays focused on the digest and attention queue. **Workbench** remains available at `/grid` and still accepts project-scoped deep links like `/grid?project=...`; the composer lives at `/new`. Session review also gets a phone-first **Changes** panel: open a session's worktree diff, see structured hunks with honest caps for large, lockfile, binary, or omitted files, tap a hunk, and send a comment back to the agent through the existing steer path.
