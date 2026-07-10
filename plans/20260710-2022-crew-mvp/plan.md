# Plan — Nuncio Crew MVP

**Started:** 2026-07-10 20:22 ACST
**Status:** implementation and local verification complete; `dev` integration tracked by GitHub
**Branch:** `feat/crew-workspace-harness`
**Target:** `dev`

## Goal

Add the smallest restart-safe Crew mode above ordinary Tasks and Sessions. Solo remains the
default. Crew runs exactly
`PLAN -> BUILD -> VERIFY -> REVIEW -> SYNTHESIZE -> DONE` in one retained worktree with one
Builder writer lease.

## Locked baseline

- Profile resolution is only `ready | needs_setup`; provider/model changes never happen silently.
- Pi, Codex, and Claude are configurable role engines; Nuncio Tester is deterministic.
- Foreman/Reviewer are read-only, Builder is workspace-write, and all explicit policies disable
  network.
- Verify and Review are mandatory and tied to the current full Git head.
- Verify-fix and review-fix caps are separate and default to 2.
- The same Builder Session handles feedback. Reviewer is reused during the loop; strict fresh
  final Reviewer applies only after a review-fix loop.
- Terminal runs are immutable. Change requests create exact-head successors.
- Full redacted verify/diff artifacts are retained within fail-closed bounds and exposed through
  UTF-8-safe progressive byte ranges.
- Verifier execution requires Seatbelt on macOS or bubblewrap on Linux.
- Crew completion is local; only `SUCCEEDED | FAILED | CANCELLED` terminal outcomes exist.
- Existing Session FSM and Session WS relay remain unchanged.

## Phase record

| Phase | Implemented scope | Status | Detail |
|---|---|---|---|
| 1 | Aggregate, reducer, schema, repositories, profiles, API | Implemented | [Phase 1](phase-01-contract-and-persistence.md) |
| 2 | Shared runtime policy and Pi/Codex/Claude enforcement | Implemented | [Phase 2](phase-02-runtime-policy-safety-gate.md) |
| 3 | Worktree, writer lease, member Sessions, context/tools | Implemented | [Phase 3](phase-03-workspace-and-member-execution.md) |
| 4 | Fixed workflow, gates, sandboxed Verify, artifacts, Attention | Implemented | [Phase 4](phase-04-fixed-quality-workflow.md) |
| 5 | Recovery, quiescence, idempotency, successors | Implemented | [Phase 5](phase-05-recovery-and-successors.md) |
| 6 | Typed core API and web/PWA Crew surfaces | Implemented | [Phase 6](phase-06-web-and-core-client.md) |
| 7 | Expo, Crew browser smoke, docs/release integration | Implemented and verified | [Phase 7](phase-07-mobile-verification-and-shipping.md) |

## Verification state

- [x] TDD contracts exist across server Crew/runtime policy, core, web, and mobile.
- [x] Crew HTTP e2e and the existing browser-smoke harness contain Crew coverage.
- [x] README, architecture, state-machine, testing, and phase docs reflect the implemented baseline.
- [x] Final aggregate `gate:full` passed; Phase 7 records the package and e2e counts.
- [x] Headless desktop/narrow real-browser acceptance passed.
- [x] Independent high-reasoning review findings were fixed and follow-up review is clean.

The PR, CI, and merge state is tracked in GitHub. This plan does not describe Crew as a stable
release before a later `dev -> main` promotion.

## Sau đó build thêm

Deferred by design:

1. Custom member prompts.
2. DAG workflows and custom roles.
3. Publish/PR/deploy actions.
4. Provider/model fallback only if separately approved as a visible policy.
5. Deeper read coverage beyond bounded context and artifact ranges.
6. Cleanup/retention automation for worktrees, Sessions, provider threads, events, and artifacts.
7. Content-attested dependency snapshots or a CAS beyond the trusted-host read-only projection.

## Open questions

None for the MVP contract. Deferred items require separate product decisions.
