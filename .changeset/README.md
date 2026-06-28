# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage
versions and the changelog. Every PR that changes user-facing behavior should include
a changeset fragment so the next release picks it up.

## Add a changeset to your PR

```bash
bun run changeset
```

This prompts you to:

1. **Select the package** — always select **`nuncio`** (the root). This is the only
   package that is versioned; `@nuncio/server` and `@nuncio/web` are synced to the
   root version automatically.
2. **Pick a bump type:**
   - `minor` — new feature or notable enhancement
   - `patch` — bug fix or small improvement
   - `major` — breaking change (rare for a self-hosted app)
3. **Write a summary** — one or two sentences describing the change from a user's
   perspective. This text becomes the changelog entry verbatim, so write it like a
   release note, not a commit message. Good: "Added a folder picker so you can choose
   a project from your phone." Bad: "fix: picker bug".

Commit the generated `.changeset/<random-name>.md` file alongside your code changes.

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
