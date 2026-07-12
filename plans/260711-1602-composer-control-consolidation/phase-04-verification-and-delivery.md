# Phase 4 — Verification and delivery

**Priority:** P0 · **Status:** Pending

## Verification matrix

1. Run targeted RED/GREEN specs from Phases 1–3, then full web tests:
   `bun run --filter @nuncio/web test`, build, and lint.
2. Run server Claude/provider specs from `apps/server`, then the full provider/unit layer needed by the
   changed registry/default contract.
3. Run `bun run gate:full`; never skip or weaken a failing test.
4. Level 5 with a Mock-provider stack and system Chrome:
   - Home: desktop + 390 px, Solo default, compact toggle, compact model trigger, switch to Crew.
   - Grid, create/edit loop, subagent row/settings, Crew profile: same trigger grammar and no overflow.
   - Form dialogs: focus trap; backdrop ignored; Escape, Close, Cancel work; nested picker works.
   - Session detail: no permission selector; advanced provider-request card still renders/responds.
   - Capture before/after dark screenshots and light-theme spot checks.
5. Inspect console/network errors and assert `scrollWidth <= clientWidth` on narrow surfaces.

## Review and release

- Run a clean xhigh code-review pass after tests; fix blockers and rerun affected proof.
- Add a **patch** changeset written from the user's perspective.
- Re-read diff for provider neutrality, accessible names/focus, advanced override preservation, and docs.
- Stage only this feature, commit conventionally, push the feature branch, and open a ready PR to `dev`.
- Merge only after all CI checks are green; then verify the resulting Nuncio Dev desktop workflow is
  signed, notarized, and published with its update assets.

## Definition of done

- The requested compact, unified controls and persistent form behavior are visually proven at Level 5.
- Exact test commands/pass counts, screenshots, review result, PR, merge commit, and Dev release are
  recorded in the final report. No unresolved questions unless implementation reveals new evidence.

