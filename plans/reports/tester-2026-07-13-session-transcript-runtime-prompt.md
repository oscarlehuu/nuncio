# Final verification — session transcript runtime prompt

Date: 2026-07-13
Worktree: `/Users/a1241968/Desktop/Oscar/nuncio-session-transcript-turn-order`

## Results

- `bun run gate`: **PASS** (exit 0).
  - Build and lint passed (existing warnings only).
  - Server: 2,515 passed, 0 failed.
  - Core: 386 passed.
  - Mobile: 124 passed.
  - Web: 946 passed.
  - Scripts: 129 passed, 0 failed.
- `bun run gate:full`, attempt 1: **FAIL** (exit 1) during its nested `bun run gate` → `bun run test:scripts`.
  - Exact test: `scripts/engine-eval-compare.spec.mjs` → `baseline write + compare round-trip (mock, end-to-end) > a run with an infra skip refuses --baseline`.
  - Assertion expected `/refusing --baseline/`; received a hermetic daemon startup failure: `EADDRINUSE` on port `55967`.
  - Script summary: 128 passed, 1 failed.
  - Server e2e and real-browser smoke were not reached on this attempt.
- Transient diagnosis after attempt 1:
  - Controller confirmed port `55967` had no listener after the failure.
  - Controller reran `bun test scripts/engine-eval-compare.spec.mjs`: **PASS**, 10 passed, 0 failed.
  - Attempt 2 passed all 129 script tests, including the formerly failing case.
  - The port collision was transient and did not reproduce.
- `bun run gate:full`, attempt 2: **PASS** (exit 0).
  - Nested build, lint, and unit/script gate passed.
  - Server e2e: 39 passed, 0 failed across 2 files.
  - Web verification: 124 files and 946 tests passed.
  - Real-browser smoke: **PASS** — level-5 UI smoke in system Chrome, covering Solo lifecycle, delegation, and the six-stage Crew workflow on the hermetic mock runtime.
- `bun run check-changeset`: **PASS** (controller rerun after attempt 1).
- `git diff --check`: **PASS** (controller rerun after attempt 1).

## Live duplicate-user-message reproduction

Read-only source: `$HOME/.nuncio/data/nuncio.db`, session `4f09a061`. The session contains 506 persisted events, sequence 1 through 506. No durable rows or implementation files were changed.

- Sequence `2`, `user_message`: canonical initial turn, 564 characters, SHA-256 prefix `0b54dc25ba0de350`; transport decoding is a no-op.
- Sequence `439`, `user_message`: 865-character legacy augmented copy, SHA-256 prefix `7a4a6eace4fe2870`; decoding removes the exact known 301-character browser-runtime suffix and yields sequence `2` byte-for-byte (`0b54dc25ba0de350`).
- Sequence `450`, `steer_message`: canonical steer, 69 characters, SHA-256 prefix `515c914d1b3d56cd`; transport decoding is a no-op.
- Sequence `505`, `user_message`: 370-character legacy augmented copy, SHA-256 prefix `ce47b140aabe82f0`; decoding removes the exact known 301-character suffix and yields sequence `450` byte-for-byte (`515c914d1b3d56cd`).
- Batch `buildTranscriptBlocks` over all 506 events rendered exactly two user blocks: `user-2` and `user-450`. Neither `user-439` nor `user-505` rendered.
- `IncrementalTranscriptBuilder`, updated one persisted event at a time, produced the same final user projection as batch. Snapshots were:
  - through `2`: `user-2`
  - through `439`: `user-2`
  - through `450`: `user-2`, `user-450`
  - through `505`: `user-2`, `user-450`

### Targeted regressions

- `bun test packages/core/src/transcript-build-blocks.spec.ts`: **PASS**, 51 passed, 0 failed.
- `bun run --filter @nuncio/web test -- src/lib/use-transcript-blocks.spec.ts src/lib/transcript-build-blocks.steer.spec.ts src/components/session-transcript.spec.tsx`: **PASS**, 3 files and 26 tests passed.
- From `apps/server`, `bun test test/unit/pi-local/pi-transcript-hydrate.spec.ts test/unit/sessions/sessions.live-watch-dedup.spec.ts`: **PASS**, 2 files and 7 tests passed.

## Cursor-preserving bounded-window projection final retest

The final persisted-event projection keeps legacy duplicate rows in API pages so replay/backfill cursors still advance, but decodes their text and marks them with `transportDuplicateOfSeq`. Shared transcript projection validates the marker and omits the user bubble. No implementation files were edited during this verification.

- Canonical prompt outside tail: `{ tail: 2 }` retained the legacy row with its original sequence and canonical decoded text, plus `transportDuplicateOfSeq` pointing to the earlier canonical row. Core rendering hid only the marked user bubble.
- All-duplicate page: server regression retained sequence `2` with `transportDuplicateOfSeq: 1`. A direct production-builder check over that one-event page produced zero user blocks from both `buildTranscriptBlocks` and `IncrementalTranscriptBuilder` while the input page still contained sequence `2`.
- Lone legacy prompt: `{ tail: 1 }` retained one unmarked user row decoded to canonical `do ABC`. Direct batch and incremental checks both rendered exactly `{ key: 'user-1', text: 'do ABC' }`.
- From `apps/server`, `bun test test/unit/sessions/sessions.live-watch-dedup.spec.ts`: **PASS**, 1 file and 7 tests passed, including cursor preservation and lone-row sanitation.
- `bun test packages/core/src/transcript-build-blocks.spec.ts`: **PASS**, 1 file and 52 tests passed, including the server-projected marker case.
- `bun run --filter @nuncio/web test -- src/lib/use-transcript-blocks.spec.ts src/lib/transcript-build-blocks.steer.spec.ts src/components/session-transcript.spec.tsx`: **PASS**, 3 files and 26 tests passed.
- Regression result: none observed.

## Integration credentials

The requested gates do not invoke the real Pi, Codex, or Claude integration suites. No integration credential skip occurred. The real-browser smoke used the hermetic mock runtime.

## Unresolved questions

None.

**Status:** DONE
**Summary:** All required verification is green. The live 506-event screenshot case renders only canonical user turns in both batch and incremental paths. The final bounded-window projection preserves duplicate-row cursors via a validated marker while rendering no duplicate bubble, and retains a lone decoded legacy turn; focused server, core, and web regressions pass. The earlier full-gate port collision was transient, and the complete retry passed including e2e and level-5 Chrome smoke.
**Concerns/Blockers:** None. The transient `EADDRINUSE` did not reproduce.
