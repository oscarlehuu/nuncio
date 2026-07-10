# Phase 5 — Recovery, idempotency, and successor runs

## Context links

- [Overview](plan.md)
- [Recovery](../../docs/crew-workspace-harness.md#durability-recovery-and-resume)
- [Recovery authority](../../docs/crew-run-authority-and-state-machine.md#recovery-authority)

## Overview

**Priority:** Release blocker
**Status:** implemented and locally verified

Implemented phase-preserving boot recovery, task/provider quiescence, durable-result replay, and
immutable exact-head successors.

## Implemented recovery

1. Scan every non-terminal run after application bootstrap.
2. Require event replay to equal the stored projection.
3. Validate canonical worktree, branch, reachability, exact full head, and phase-specific
   cleanliness.
4. Replay an already durable structured result idempotently.
5. Release stale Builder lease and reuse a resumable Session; otherwise create linked member
   lineage with the same frozen binding.
6. Queue the preserved phase after `recovery_succeeded`.
7. Block and quiesce on missing/diverged/stale state.

Interrupted Verify is rerun only after exact current-head and clean-boundary proof. Dirty Build
state is retained only through the explicit recovery marker. Provider unavailability preserves
phase and blocks; restoration passes through Recovering.

## Successors

A terminal run remains unchanged. Successor creation requires expected prior revision, expected
base head, and a canonical clean retained worktree. It records `priorRunId`, a new immutable
snapshot, bounded prior plan/decisions/synthesis/evidence, and invalid new gates. Compatible
Foreman/Builder Sessions may continue; Reviewer Session does not carry into the successor.

## Architecture and files

`crew-recovery.service.ts`, `crew-recovery-projection.ts`,
`crew-run-quiescer.service.ts`, `crew-run-control.service.ts`, `crew-runner-blocker.service.ts`,
`crew-successor.service.ts`, attempt correlation, and Task/Session/Git adapters.

## TDD evidence

Recovery/repository/quiescer specs cover replay mismatch, stale/missing/dirty boundaries,
provider loss/restoration, resumable/replacement member, checkpoint-to-result and
result-to-lease-release crash gaps, durable-result replay, duplicate callbacks, Verify rerun,
owner-aborted gate exclusion, and Attention. Task specs reject generic enqueue/multitask under
Crew-owned member Sessions. Successor specs cover exact-head conflicts,
active-run conflict, new snapshots/gates, prior immutability, and compatible Session continuation.

## Success criteria

- [x] Daemon replacement does not automatically fail active CrewRuns.
- [x] Recovery does not duplicate attempts, results, events, artifacts, or terminal transitions.
- [x] Unexpected Git state is never reset or adopted.
- [x] Terminal history is immutable and successor lineage explicit.
- [x] Restart reconciliation e2e and pause/resume browser proof are recorded in Phase 7.

## Risk and security

Recovery never changes a frozen provider/model. Quiescence aborts Verify, stops member producers,
cancels correlated tasks, and releases the writer lease before terminal or recovery actions.

## Next step

Phase 6 consumes the projected API in shared core and web/PWA.
