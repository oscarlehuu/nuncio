# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage
versions and the changelog. Every PR that changes user-facing behavior should include
a changeset fragment so the next release picks it up.

## Add a changeset to your PR

**Agents (preferred — non-interactive):**

```bash
bun run add-changeset patch "Fixed steer composer clearing your draft on reconnect."
# or
bun run add-changeset minor "Added session export from the sidebar."
git add .changeset/*.md
```

**Humans (interactive):**

```bash
bun run changeset
```

Both create a `.changeset/<slug>.md` file. Pick bump type per **AGENTS.md → Versioning rubric**:

- **`patch`** (default) — bug fix, polish, perf, copy
- **`minor`** — new end-to-end feature or workflow
- **`major`** — breaking change (rare pre-1.0)

Always select / target the root **`nuncio`** package only.

Write the summary from a user's perspective — it becomes the changelog entry verbatim.
Good: "Added a folder picker so you can choose a project from your phone."
Bad: "fix: picker bug".

Commit the generated `.changeset/*.md` file alongside your code changes.

## CI gate

PRs that change user-facing source (`apps/web/src`, `apps/server/src`, `apps/landing/src`, `mockup.html`) **must** include a new `.changeset/*.md` fragment. CI runs `bun run check-changeset`.

Pure refactor touching source but no user-visible behavior? Add `<!-- no-changeset -->` to the PR description.

Verify locally before pushing:

```bash
bun run check-changeset
```

## What happens on merge

A GitHub Actions workflow (`release.yml`) opens a **"chore: release version"** PR that:

- runs `bun run version` (consumes all pending changesets, bumps the root version,
  prepends a new section to `CHANGELOG.md`)
- commits the result to the version PR

After merging locally, run `bun run sync-versions` if you want workspace
`package.json` files to match the root version (optional — not part of CI
because changesets/action reads per-package changelogs for any version bump).

Merge that PR to cut a release. On merge, the workflow:

- creates a git tag `v<version>`
- publishes a GitHub Release with the matching `CHANGELOG.md` section as the body

## Manual release (local)

```bash
bun run version         # consume changesets, bump versions, update CHANGELOG.md
bun run release         # create v<version> tag + GitHub Release
```

`bun run release` is a no-op if the tag for the current version already exists, so it
is safe to re-run.
