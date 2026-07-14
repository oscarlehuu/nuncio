# Phase 03 — Tests, docs, changeset

**Status:** pending  
**Priority:** P1  
**Depends on:** [phase-02-overlay-steer.md](./phase-02-overlay-steer.md)

## Overview

Close the shipping gate: regression coverage, surface docs, user-facing changeset. No new product behavior.

## Requirements

- Server: no schema change expected; if any DTO touch, unit coverage
- Web: Vitest for serialize + overlay + browser-panel Design Mode toggle
- Desktop: pick bridge enter/leave/pick shape tests
- Docs: `docs/product-surfaces.md` — Design Mode under session inspector browser dock (desktop-only)
- Brief mention in `AGENTS.md` Gotchas or browser section if conventions shift
- Changeset: `minor` — new end-to-end user workflow (Design Mode) per versioning rubric

## Related files

| Action | Path |
|---|---|
| Edit | `docs/product-surfaces.md` |
| Maybe | `AGENTS.md`, `README.md` (short) |
| Add | `.changeset/*.md` via `bun run add-changeset minor "…"` |

## Todo

- [ ] `bun run --filter @nuncio/web test` green for new specs
- [ ] Desktop tests green
- [ ] `bun run gate` green
- [ ] product-surfaces updated
- [ ] changeset minor with release-note voice

## Success criteria

- Gate green; docs match UI; changeset present for user-facing Design Mode.

## Rollback

Revert docs/changeset with feature revert.

## Next

Optional Slice 2 (separate plan): wire `InAppBrowserBackend` so agent tools share the dock tab; Fiber/source mapping; draw/voice.
