---
"nuncio": minor
---

Added Autopilot — standing **loops** you hand a goal to and walk away from. A loop fires on a schedule (`daily@22:00`, `every:6h`, `mon@09:00`), and each fire enqueues a task that runs in a fresh worktree, self-fixes a failing verify through the existing auto-fix loop, and lands its work as a pull request. Loops run inside a daily run budget, auto-pause after 3 consecutive failed runs and flag as needing you, and can stop themselves after N total runs or N consecutive green verifies. Schedules, budgets, and the failure breaker are all rebuilt from durable SQLite at boot, so a restart never forgets a loop's next run or its streak. The new **Autopilot** view lists every loop with its status, today's budget usage, last run, and expandable run history, plus a create form with an inline-validated schedule picker. Loops are scoped to a first-class **project**: a new **Projects** settings section lets you set per-project defaults — engine, worktree policy, verify command, and an auto-fix override — layered above the global settings, so a loop inherits exactly the right behavior for the repo it runs in.

Followed up with a v1.1 batch that turns Autopilot into something you can actually run day-to-day:

- A **dashboard** on the Autopilot view leads with fleet-wide stats — active/broken loop counts and a 14-day sparkline of green vs. failed runs — before the loop list.
- Every loop gets its own **detail page** (`/autopilot/:id`) with tabs for overview, settings, and run history; rename a loop inline, and fire it on demand with a **Run now** button that reports the truthful reason when a fire is skipped (already running, or today's budget is exhausted) instead of pretending it fired.
- A **template gallery** seeds the create-loop form with a few common loop shapes (nightly maintenance, PR triage, dependency bump) so you're not staring at a blank goal field.
- A global **run history** view (`/autopilot/runs`) lists every run across every loop, and each run drills down GitHub-Actions-style into its verify output, failure reason, duration, and an **Open session** link into the underlying task.
- Loops can now be **named** (falls back to the goal when unset) and given a **per-loop engine override**, independent of the scoped project's default engine.
- Each run's prompt now carries a **"Previous run context"** block — the prior run's outcome, consecutive-failure streak, today's budget usage, and a tail of the last verify output — so a loop's next attempt picks up where the last one left off instead of starting blind.
- The **project picker** is now forge-aware: browse your GitHub/GitLab repos straight from Nuncio (via your existing CLI credentials) and **clone** one directly into a configurable `NUNCIO_CLONE_DIR`. A private clone injects the credential as a one-shot header for that single `git clone` invocation — the token is never written into the repo's config or persisted anywhere.
