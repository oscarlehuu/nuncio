# Crew composer and branch picker review

## Findings

### P2 — CONFIRMED: remote default discovery is hard-coded to `origin`

`apps/server/src/git/git.service.ts:366-376` enumerates every remote and already receives each symbolic ref target, but discards that target and later probes only `refs/remotes/origin/HEAD`. In a valid remote-only repository whose remote is named `upstream`, with `upstream/HEAD -> upstream/main`, detached HEAD, and refs `upstream/feature` plus `upstream/main`, the `origin/HEAD` probe fails and insertion order marks `upstream/feature` as default. `BranchPicker` then auto-selects the wrong base, so a session or Crew task can start from a feature branch instead of the repository's declared remote default. Preserve symbolic-ref metadata from the `for-each-ref` result and choose its target when no local default/current row exists; add a remote-only, non-`origin` regression test.

### P2 — CONFIRMED: Crew setup links escape the active hub-machine basename

`apps/web/src/components/crew/crew-profile-picker.tsx:34-41` introduces the empty-profile action as `<a href="/settings?...">`; the touched needs-setup path has the same absolute-root link at `apps/web/src/components/crew/resolved-crew-preview.tsx:21-26`. The app router runs with `basename={API_BASE}` under `/m/<machine>`, so those anchors navigate to the hub root's settings instead of `/m/<machine>/settings` and configure the wrong machine. Use a router `Link` (or a basename-aware helper) and cover a `/m/studio` render/navigation case.

## Verified

- Local/remote ref dedup and `origin/HEAD` exclusion work for the covered repository shape; qualified remote-only names remain valid Git revisions.
- Grid passes the selected machine's absolute API base to both project and branch pickers.
- Web and mobile generated `nuncio/<uuid>-...` branches are filtered for local and ordinary one-segment remote names.
- Crew still submits the selected `baseBranch`; server resolution freezes its exact commit and always creates the isolated Crew worktree from that frozen head.
- Compact switch/profile loading and empty states preserve Solo default, accessible switch/menu roles, and narrow-toolbar behavior.
- Smoke additions use an ephemeral data directory, free port, local Git fixture, reduced motion, and cleanup through the shared hermetic stack.
- Targeted verification passed: web 40 tests, mobile 4 tests, server Git service 60 tests.

## Unresolved questions

None.

## Resolution

- Preserved symbolic default metadata for every remote and added non-`origin` coverage.
- Deduplicate local/remote names only when both refs resolve to the same commit; divergent refs remain selectable.
- Routed both Crew settings actions through the machine-aware base helper.
- Re-ran focused regressions (server Git 62/62, affected web 41/41) and `gate:full` successfully.

**Status:** DONE
**Summary:** Both confirmed edge-path regressions were fixed and verified before merge.
**Concerns/Blockers:** None.
