# Desktop window-state documentation audit

## Result

Required shipped docs are present and match the implementation. No roadmap milestone, ADR,
route, Settings section, API, web, or mobile behavior changed.

## Verification

- `README.md` accurately promises restore of normal size/position, maximized state, and launch-time
  display safety.
- `docs/product-surfaces.md` correctly maps this as Electron-shell-only behavior and states that
  bounds are revalidated whenever the shell creates a window.
- `docs/system-architecture.md` matches the implemented `userData/window-state.json` schema,
  `getNormalBounds()` source, display work-area fitting, negative origins, debounce/flush points,
  failure-soft fallback, and test locations.
- The changeset targets root `nuncio` with `patch`, correct for user-visible desktop polish under
  the repo rubric. Its release note now says bounds move back on-screen **at launch**, avoiding an
  unsupported live display-hotplug claim.
- `docs/development-roadmap.md` and `docs/project-changelog.md` do not exist in this repository and
  are not its canonical artifacts. Roadmaps live under `plans/`; this feature already has
  `plans/260717-1900-desktop-window-state/`. Release notes live in per-PR changesets and are folded
  into root `CHANGELOG.md` only by the version-release workflow. Direct `CHANGELOG.md` edits are
  explicitly disallowed here.
- `bun run check-changeset` and `git diff --check` pass.

## Remaining concern

- Pre-existing comments in `apps/desktop/electron-builder.config.cjs:6-7` and
  `apps/desktop/src/main.js:1094-1095` say packaged SQLite lives under per-app `userData`. Runtime
  code instead sets shared `~/.nuncio/data` through `NUNCIO_DATA_DIR`. Not changed because this
  task forbids code/config edits; shipped README and architecture wording are correct.

## Unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** Required docs and patch changeset verified; one release-note phrase corrected for launch-time behavior.
**Concerns/Blockers:** Two stale, pre-existing desktop code/config comments misdescribe SQLite location; no blocker to window-state docs.
