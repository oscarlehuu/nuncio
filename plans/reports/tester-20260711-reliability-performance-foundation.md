# Reliability & Performance Foundation — Tester Report

**Date:** 2026-07-11
**Worktree:** `/Users/a1241968/Desktop/Oscar/nuncio-reliability-performance-foundation`
**Result:** PASS — frozen snapshot clears targeted tests, all unit layers, e2e, and hermetic level-5 browser smoke.

## Commands and results

| Cwd | Command | Result |
|---|---|---|
| root | `bun run --filter @nuncio/core check` | PASS — typecheck + lint; 33 files, 362 tests |
| root | `bun run --filter @nuncio/web test` | PASS — 114 files, 886 tests |
| root | `bun run --filter @nuncio/web build` | PASS — 2,163 modules transformed |
| root | `bun run --filter @nuncio/web lint` | PASS with warnings |
| `apps/server` | `bun test test/unit/sessions/events.repository.spec.ts test/unit/observability/ test/unit/attention/heartbeat/digest-session-source.spec.ts test/unit/db/database.service.spec.ts` | PASS — 55 tests, 9 files, 120 expects |
| `apps/server` | `bun test test/unit/` | PASS — 2,337 tests, 256 files, 5,961 expects |
| root | `bun run gate` | PASS — build/lint; server 2,337; core 362; mobile 91; web 886; scripts 127 |
| root | `bun run gate:full` | PASS — repeated gate plus server e2e 39/39, web 886/886, UI smoke PASS |

Targeted regression reruns after the test-isolation/channel fixes:

- `bun run --filter @nuncio/web test -- use-session-stream`: PASS, 24/24.
- `bun run --filter @nuncio/web test -- App.spec.tsx`: PASS, 29/29.

## Full-gate details

- Server e2e: 39 passed across 2 files, 185 expects, 0 failed.
- Hermetic browser smoke: PASS on temporary port `54772` and temporary data dir; no canonical port was reused or changed.
- Smoke covered 15 checks: Mock Solo create/stream/steer/archive, delegation digest + lineage navigation, and the fixed Crew workflow through current-head terminal success, mobile/desktop composer behavior, narrow-layout overflow, and inspect-only member state.
- No skipped, ignored, or weakened tests. No files edited except this requested report.

## Warnings

Non-blocking warnings introduced in a changed test file:

- `apps/web/src/lib/use-session-stream.spec.tsx:22`: `typescript(no-this-alias)` in the WebSocket test double.
- `apps/web/src/lib/use-session-stream.spec.tsx:70`: `eslint(no-unsafe-optional-chaining)` in a test helper.

Pre-existing or environment warnings, not introduced by this implementation:

- Core lint: `src/model-options.ts:42` no-useless fallback in spread; `src/transcript-build-blocks.ts:174` misleading Unicode character class.
- Existing web lint warnings in unchanged components/hooks (`only-export-components`, hook dependency warnings).
- Vite reports existing chunks above 500 kB after minification; bundle-budget tests still pass.
- Vitest workers print Bun/Node's experimental `localStorage` warning because no `--localstorage-file` is configured.

## Failure history resolved before freeze

- Initial full web run failed 2 App lifecycle assertions because the test mock emitted channel `s` while the active pooled channel was `new1`.
- Initial isolated stream run failed 17/24 because the module-owned relay pool was not reset between test cases.
- Test isolation and exact-channel emission were corrected; the frozen reruns and all gates are green.

## Post-review blocker rerun

The final frozen snapshot includes both shared-relay reviewer fixes: per-consumer cursor filtering and per-consumer closed-state guards. The relay suite added four assertions (28/28 targeted tests before handoff); the independent final rerun then verified the full affected and repository-wide surfaces:

- Core check: PASS, 33 files and 362/362 tests.
- Full web suite: PASS, 114 files and 886/886 tests.
- `bun run gate`: PASS on retry with server 2,337, core 362, mobile 91, web 886, and scripts 127.
- `bun run gate:full`: PASS, including a second complete gate, server e2e 39/39, web 886/886, and all 15 hermetic Chrome smoke checks.

The first post-review `bun run gate` attempt had one failure in `scripts/engine-eval-compare.spec.mjs` (`baseline write + compare round-trip`). It did not reproduce: the isolated file passed 10/10 (including the failing case), then the complete scripts layer passed 127/127 in both the gate retry and `gate:full`. No relay/product failure was observed; classified as a non-reproducing script-test flake and retained here for traceability.

## Unresolved questions

None. The two test-lint warnings and the single non-reproducing script-test flake are cleanup/monitoring candidates, not gate blockers.

**Status:** DONE
**Summary:** Independently verified the post-review frozen implementation through full unit, e2e, and real-browser smoke layers; all required gates pass.
**Concerns/Blockers:** None; two non-blocking warnings in the changed WebSocket test double and one non-reproducing script-test flake are documented.
