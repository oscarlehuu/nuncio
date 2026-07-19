# Tester report — Pi first-class provider

- Date: 2026-07-17 19:30 AEST
- Branch: `perf/pi-first-class-provider`
- HEAD: `cbffbf722a9f0c93b0d8b1e1e7cdc683e32cc3ce`
- Scope: independent read-only verification of the Pi performance/lifecycle patch
- Source/test edits: none

## Outcome

PASS. Changeset validation passed, the performance command proved billable-opt-in safe, and the
full minimum gate passed. The paid real-provider integration was intentionally not rerun; its
separate 8-pass result remains root-agent evidence, not evidence produced by this tester run.

## Diff inspected

- Pi lifecycle: turn activation fencing, interruption settlement, open thinking/tool sealing, and
  successful textless/tool-only completion tracking.
- External memories: successful normalized project-to-repository resolution cached per service;
  failed probes and memory/index contents remain uncached.
- Tests: unit regressions for cache reuse/fresh reads, stale callback fencing, interrupted activity,
  tool-only completion, and first-delta durability; real integration made cheap-model-first and
  event-driven.
- Delivery: opt-in Pi performance harness, patch changeset, README/architecture/testing docs, and a
  report-only baseline.

`git diff --check` exited 0.

## Commands and results

### `bun run check-changeset`

- Exit: 0
- Output: `changeset check passed.`
- Fragment inspected: `.changeset/improved-nuncio-engine-startup-and-prevented-too.md`
- Bump: patch; summary matches startup improvement and fake no-response correction.

### `bun run perf:pi`

- Exit: 0
- Output: `Pi perf skipped: set NUNCIO_PI_PERF=1 or pass --run to allow real, billable prompts.`
- Safety: pass. Harness checks opt-in before `loadRuntime()`, auth/model discovery, temp DB setup, or
  model prompts. This invocation made no paid provider request.

### `bun run gate`

- Exit: 0
- Elapsed: about 207.84 seconds
- Build: server 0; web 0.
- Lint/typecheck: server, web, core, mobile, desktop all 0.
- Server: 2,912 passed, 0 failed across 321 files.
- Core: 424 passed across 39 files.
- Mobile: 124 passed across 20 files.
- Desktop: 75 passed, 0 failed across 8 files.
- Web: 1,108 passed across 155 files.
- Scripts: 144 passed, 0 failed across 13 files.
- Aggregate tests: 4,787 passed, 0 failed.

Changed-area regressions observed green inside the gate:

- reuses one successful Git-root probe while rereading changed memory files;
- seals interrupted Pi activity once and ignores callbacks outside the active turn;
- emits no fabricated assistant message for a successful tool-only turn;
- persists and emits the first Pi delta before a burst completes;
- preserves Pi retry/error, tool, thinking, persisted-thread, and provider-contract behavior.

Non-failing diagnostics: existing warning-only lint findings in unchanged files, Vite's bundle-size
advisory, and Node's test-only `localStorage` experimental warning. None affected exit status or the
changed Pi scope.

## Post-review rerun — 2026-07-17 19:49 AEST

PASS on the final post-review tree. This fresh rerun includes the review hardening for failed
Git-root probes, real-provider teardown, performance deadlines, and a hanging interrupt
acknowledgement. Source and test files remained read-only during this tester pass.

- `git diff --check`: exit 0; no output.
- `bun run check-changeset`: exit 0; `changeset check passed.`
- `bun run perf:pi`: exit 0; safely skipped before runtime/model setup because billable opt-in was
  absent. No paid provider request was made.
- `bun run gate`: exit 0. Build and all lint/typecheck layers passed.
- Server: 2,916 passed, 0 failed across 322 files.
- Core: 424 passed across 39 files.
- Mobile: 124 passed across 20 files.
- Desktop: 75 passed, 0 failed across 8 files.
- Web: 1,108 passed across 155 files.
- Scripts: 146 passed, 0 failed across 14 files.
- Aggregate: **4,793 passed, 0 failed**.

New post-review regressions observed green inside the gate:

- a failed Git-root probe is retried, then only a successful repository-root resolution is cached;
- real-provider cleanup waits for an interrupted run to settle and fails clearly when it cannot;
- real-provider cleanup remains time-bounded when the interrupt acknowledgement itself hangs;
- the performance deadline still rejects a timed-out sample when abort settles the run;
- the performance deadline remains time-bounded when neither abort nor the measured run settles.

The paid Pi integration now consumes the bounded cleanup helper, but it was intentionally not run
in this tester pass. Its behavior is covered here by deterministic unit regressions; no claim is
made that the real-provider path was exercised post-review.

## Concerns

No blocker. The checked-in performance baseline has high sample variability (roughly 28–49% CV)
and used an explicit `cliproxyapi:claude-sonnet-4-6` override. It is correctly documented as
report-only evidence; do not infer a stable latency threshold or general speed claim from this one
run. This tester did not rerun that billable baseline.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Final post-review tree passed diff, changeset, opt-in safety, and the 4,793-test gate.
**Concerns/Blockers:** None; timing evidence remains intentionally non-gating and noisy.
