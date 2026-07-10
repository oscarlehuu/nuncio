# Phase 6 — Core client and web/PWA

## Context links

- [Overview](plan.md)
- [Crew API and clients](../../docs/crew-workspace-harness.md#api-and-client-surfaces)
- [Verification matrix](../../docs/testing-and-verification.md#crew-verification-matrix)

## Overview

**Priority:** High
**Status:** implemented and locally verified

Added strict typed Crew transport/projections and the web/PWA creation, profile, run, member,
gate, outcome, and artifact surfaces.

## Implemented behavior

- Fresh Home composer always defaults Solo; its request controls/payload remain compatible.
- Crew selection hides per-run provider controls and requires server-authored `ready`.
- Profile Settings edits frozen role bindings, exact 2/2 caps, verify command, and freshness policy.
- Run detail shows fixed phase order, status/recovery, counters, current gates, ordinary member
  Session links, immutable history, valid expected-revision actions, and successors.
- Artifact metadata is a closed typed union; parser drops internal path/command/cwd fields.
- Verify log and workspace diff load in bounded 16 KiB chunks using server `nextOffset`, with
  loading, retry, end, stale-generation, and duplicate-request guards.
- Review cap/block state shows only the latest current-head blocker title/body.

## Architecture and files

- Core: `packages/core/src/crew-*.ts` for API, transport, types, projections, structured results,
  outcomes, artifact evidence, and strict parsers.
- Web: `apps/web/src/components/crew/` plus Home/Settings/Attention/App routing integration.
- Existing Session streaming remains unchanged; active Crew detail uses REST projection/events.

## TDD evidence

Core specs cover malformed payloads, run scoping, expected revisions, result/artifact allowlists,
UTF-8 byte accounting, current-head evidence, and projections. Web specs cover Solo default,
readiness races, duplicate create/load actions, fixed progress/gates/history, member links,
blockers, progressive artifacts, errors/end state, and responsive semantics.

## Success criteria

- [x] Clients never resolve or substitute providers/models.
- [x] Only current-head gate evidence is actionable.
- [x] Artifact paging never uses JavaScript string length as a byte cursor.
- [x] Attention acknowledgment cannot advance a run.
- [x] No control exists outside the fixed local workflow.
- [x] Final core/web test, build, lint, and browser counts are recorded in Phase 7.

## Risk and security

All ids are path-encoded, responses fail closed, mutations use expected revision, and artifact
public shape is rebuilt from allowlisted fields rather than cast from server JSON.

## Next step

Phase 7 completes Expo parity, shared smoke coverage, docs, and final release proof.
