# Phase 7 — Expo, end-to-end verification, and merge preparation

## Context links

- [Overview](plan.md)
- [Crew verification matrix](../../docs/testing-and-verification.md#crew-verification-matrix)
- [Working practice](../../AGENTS.md#working-practice-tdd-first)

## Overview

**Priority:** Release gate
**Status:** implementation and local verification complete

Added essential Expo Crew control, Crew coverage to the existing browser-smoke harness, and
synchronized baseline documentation. Stable-release promotion is tracked separately.

## Implemented mobile surface

- Solo-default composer with ready-profile Crew creation.
- Crew run list/detail navigation and push/deep-link routing.
- Fixed progress, gate cards, member Session links, outcome evidence, valid run actions, and
  terminal successor request.
- Progressive verify/diff artifact viewer with server byte cursor, loading/retry/end states, and
  duplicate/stale request protection.
- Safe-area/narrow-screen controls; profile editing remains in web/PWA Settings.

## Verification integration

- `apps/server/test/e2e/crew.e2e-spec.ts` is part of the server `test:e2e` script.
- `scripts/smoke-ui.mjs` calls the shared Crew smoke flow with forced Mock; no second stack.
- Core/web/mobile package suites cover strict transport and UI state.
- README, Crew docs, ADR, system architecture, testing guide, and this plan now match source.

## Final local proof

- [x] Server Crew unit suite: 194 passed; Crew HTTP e2e: 10 passed.
- [x] Full server e2e: 39 passed; core: 345; web: 850; mobile: 74; scripts: 126.
- [x] `bun run gate:full` passed with build, lint/typecheck, unit, e2e, and browser layers.
- [x] Headless real-browser smoke passed on desktop and narrow layouts without taking over the
  user's visible browser; Solo lifecycle and Crew pause/resume through terminal success passed.
- [x] Independent high-reasoning correctness/security findings were fixed; scoped verifier
  follow-up returned no finding.
- [x] Minor changeset exists; branch-flow and changeset checks run again against latest `dev`
  immediately before PR.

## Success criteria

- [x] Expo supports creation, monitoring, evidence, intervention, and successors.
- [x] Solo remains the default on mobile.
- [x] Browser smoke reuses the existing hermetic stack.
- [x] Documentation says implemented and verified for the `dev` lane, not stable-shipped.
- [x] All local proof above is recorded; GitHub owns PR/CI/merge state.

## Risk and security

Use Mock for UI proof and the cheapest model only for an adapter seam that requires real-provider
integration. Screenshots and reports must exclude secrets, internal artifact paths, commands, and
cwd. Respect canonical ports and stop test servers.

## Next step

Hand the verified branch to the normal `dev` PR/CI flow. A later `dev -> main` promotion is the
separate stable-release boundary.
