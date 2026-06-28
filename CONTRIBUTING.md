# Contributing to Nuncio

Thanks for considering a contribution! Nuncio is a self-hosted, mobile-first web app for delegating tasks to AI coding agents. This guide covers setup, the workflow we use, and how to get a change merged.

> **TL;DR:** Work TDD-first (red → green → refactor), add a Changeset for any user-facing change, keep the suite green, and sync docs. Open a PR against `main`.

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3** — Nuncio runs on Bun for the server, build, and tests. The server uses `bun:sqlite` (a Bun builtin), so Node will not work for the server.
- **Git**
- **[Tailscale](https://tailscale.com)** (optional) — only needed if you want to test the production PWA install path from a phone.
- **Pi credentials** (optional) — only needed to run the real-Pi integration tests. Without `~/.pi/agent/auth.json`, the integration suite self-skips and the app falls back to the Mock provider.

## Setup

```bash
git clone https://github.com/oscarlehuu/nuncio.git
cd nuncio
bun install
bun run dev          # API on :3000, web on :5173 (proxies /api → 3000)
```

Open http://localhost:5173 — the web UI talks to the API through Vite's proxy.

## Project layout (essentials)

```
apps/server/   NestJS API + provider-agnostic agent harness (Bun runtime)
apps/web/      Vite + React + Tailwind v4 + shadcn/ui (installable PWA)
docs/          system-architecture.md
plans/         phased roadmap + per-phase reports (decision history)
scripts/       sync-versions.mjs, release.mjs (release automation)
.changeset/    Changesets config + pending release-note fragments
```

See [AGENTS.md](AGENTS.md) for the full layout, architecture, and conventions — it's the canonical context file for anyone (human or agent) working in the codebase.

## Working practice: TDD-first

**Always start from a failing test.** No implementation code lands without a failing test that specifies the behavior first. Red → Green → Refactor, every change:

1. **Red — write the test first.** Add a `*.spec.ts` under `apps/server/test/unit/<domain>/` (grouped by domain, not co-located) that captures the desired behavior. Run it and confirm it fails for the *right* reason (a real assertion failure, not a compile/import error).
2. **Green — implement the minimum** to make the test pass. No more, no less.
3. **Refactor** under the safety of the passing test.
4. **Gate:** the change is not done until the suite is green. Don't open a PR on a red suite. **Never silence, skip, or weaken a failing test just to pass the build.**

For frontend changes, the same loop applies with Vitest (specs co-located as `*.spec.tsx`).

### Bugs and refactors

- **Bugs:** write a test that reproduces the bug (red), then fix (green). No bug fix without a regression test.
- **Refactors:** keep existing tests green throughout. If a refactor requires changing tests, it isn't a refactor — it's a behavior change; split it.

## Commands

```bash
bun run dev                                   # server (3000) + web (5173) concurrently
bun run build                                 # build server + web
bun run test                                  # server unit tests
bun run lint                                  # server tsc --noEmit + web oxlint
bun run --filter @nuncio/server test:e2e      # HTTP e2e
bun run --filter @nuncio/server test:integration  # real Pi auth (opt-in; self-skips without ~/.pi/agent)
bun run --filter @nuncio/web test             # web component tests (vitest)
```

## Releases & changelog

Versioning and the changelog are managed by [Changesets](https://github.com/changesets/changesets). The flow is **curated, not commit-driven** — each PR ships a hand-written summary fragment that becomes the changelog entry verbatim, so it reads like release notes (Superset/Cursor style), not a commit log.

**For every PR that changes user-facing behavior, add a changeset:**

```bash
bun run changeset        # → select "nuncio", pick minor/patch/major, write a release-note-style summary
git add .changeset/*.md  # commit the fragment alongside your code
```

Write the summary from a user's perspective (it becomes the changelog entry as-is).

- **Good:** "Added a folder picker so you can choose a project from your phone."
- **Bad:** "fix: picker bug"

PRs that are pure refactors, tests, or docs do **not** need a changeset.

Merging a PR with changesets triggers a `chore: release version` PR that bumps the version and updates `CHANGELOG.md`; merging that PR cuts the release (git tag `v<version>` + GitHub Release). See [`.changeset/README.md`](.changeset/README.md) and [AGENTS.md → Releases & changelog](AGENTS.md) for the full automation flow.

## Pull request process

1. **Branch** from `main`. Use a descriptive name (e.g. `feat/folder-picker`, `fix/sse-replay-cursor`).
2. **TDD-first** — see above. The suite must be green before you open a PR.
3. **Add a changeset** if the change is user-facing.
4. **Sync docs** — update `README.md` (commands, API, architecture, status) and `AGENTS.md` (if architecture or conventions shifted). A merged change with stale docs isn't done.
5. **Run the full gate locally:**
   ```bash
   bun run lint
   bun run test
   bun run --filter @nuncio/web test
   bun run build
   ```
6. **Open the PR** against `main` and fill in the template.
7. **Code review** — every PR is reviewed before merge. Fix blockers; document warnings inline. Tests green alone is not done — review is part of the shipping gate.

## Code style

- Don't be too harsh on linting, but **make sure there are no syntax errors and the code compiles**.
- Prioritize functionality and readability over strict style enforcement.
- Use reasonable code quality standards that enhance developer productivity.
- Use try/catch error handling where it matters; follow existing patterns for error boundaries.
- Follow security best practices — never log secrets or API keys, never commit `.env` files or credentials.

## Commit messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add folder picker
fix: prevent duplicate events on SSE reconnect
docs: update README quick start to use bun
refactor: split sessions.service into domain modules
test: add regression test for archive-then-restore
chore: bump dependencies
```

Keep commits focused on actual code changes. No AI references in commit messages.

## Dev server ports — don't squat new ports

If a Nuncio process is already listening on **3000** or **5173**, stop it and restart on that same port — do **not** spin up a second instance on 5174, 5175, etc. Extra ports break the Vite `/api` proxy and leave orphan processes. See [AGENTS.md → Dev servers](AGENTS.md) for the rationale.

## Questions?

- Bugs and features → [open an issue](https://github.com/oscarlehuu/nuncio/issues/new/choose).
- Security reports → see [SECURITY.md](SECURITY.md) — **do not** open a public issue for vulnerabilities.
- Architecture and conventions → [AGENTS.md](AGENTS.md) and [docs/system-architecture.md](docs/system-architecture.md).
