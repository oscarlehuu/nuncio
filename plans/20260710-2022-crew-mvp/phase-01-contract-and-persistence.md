# Phase 1 — Contract, reducer, persistence, and API

## Context links

- [Overview](plan.md)
- [Crew harness](../../docs/crew-workspace-harness.md)
- [Authority/state machine](../../docs/crew-run-authority-and-state-machine.md)
- [Backend research](../reports/researcher-2026-07-10-crew-backend.md)

## Overview

**Priority:** Critical
**Status:** implemented and locally verified

Introduced a separate durable Crew aggregate without changing the Session FSM or Session WS relay.

## Implemented contract

- Exact phases: `PLAN | BUILD | VERIFY | REVIEW | SYNTHESIZE | DONE`.
- Exact outcomes: `SUCCEEDED | FAILED | CANCELLED | null`.
- `CrewTask` holds stable intent; terminal `CrewRun` rows never reopen.
- Append-only run events, monotonic sequence, idempotency key, expected-revision CAS, and replay.
- Immutable profile snapshots with exact bindings, runtime policies, verify command, independent
  default 2/2 caps, and strict reviewer-freshness policy.
- Profile resolution returns only `ready | needs_setup`.
- Additive profile/task/run/events/command REST API.

## Architecture and files

- Domain: `apps/server/src/crew/domain/crew.types.ts`,
  `crew-run.reducer.ts`, `crew-results.ts`.
- Persistence: `crew-schema.ts` plus profile/task/run/event/member/result/artifact/lease
  repositories under `apps/server/src/crew/persistence/`.
- Resolution/API: `crew-profile.resolver.ts`, `crew-provider-catalog.service.ts`,
  `crew.service.ts`, `api/crew.controller.ts`, and Crew modules.
- Database bootstrap and app wiring stay additive.

## TDD evidence

- `crew-run.reducer.spec.ts`: exact path, illegal tuples/events, independent caps, stale
  context/head, recovery statuses, duplicate safety, terminal immutability.
- `crew-profile.resolver.spec.ts`: exact live bindings/policies, reviewer independence, snapshot
  immutability, verify command, sandbox readiness.
- `crew-repositories.spec.ts` and `crew.controller.spec.ts`: schema/replay/CAS/rollback/API
  validation and conflict responses.

## Success criteria

- [x] Crew state is independent of Session state.
- [x] Replay reproduces the stored projection.
- [x] Duplicate idempotency cannot advance twice.
- [x] Saved-profile edits do not mutate run snapshots.
- [x] The public API exposes no generic transition verb.
- [x] Final aggregate gate counts are recorded in Phase 7.

## Risk and security

All SQL uses positional parameters. Inputs are bounded and normalized. Public artifact data never
accepts or returns a storage path. The reducer is the only transition authority.

## Next step

Phase 2 applies enforceable provider-neutral policy to ordinary member Sessions.
