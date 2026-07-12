# Phase 4 — Fixed Quality workflow and gates

## Context links

- [Overview](plan.md)
- [Exact transitions](../../docs/crew-run-authority-and-state-machine.md#exact-workflow-transitions)
- [Artifacts](../../docs/crew-workspace-harness.md#redacted-artifacts-and-progressive-reads)

## Overview

**Priority:** High
**Status:** implemented and locally verified

Implemented the mandatory six-phase loop, deterministic Tester, independent caps, Reviewer
freshness, bounded artifacts, and Crew Attention.

## Implemented behavior

- Plan auto-accepts unless a structured material clarification is present.
- Builder intent is finalized against canonical Git and the same Builder Session handles fixes.
- Verify is Nuncio-owned, current-head, and mandatory.
- Review is mandatory; warnings remain visible, blockers return through Build then Verify.
- Verify-fix and review-fix caps are independent/default 2; extra round is gate-specific.
- Reviewer is reused during feedback; strict fresh final Reviewer occurs only after review feedback.
- Synthesis can complete only after current workspace, Verify, diff, Review, artifact-integrity,
  and Reviewer-lineage checks.
- Cap/provider/recovery blockers reconcile one existing Attention item.

## Sandbox and artifacts

`CrewCommandRunner` requires Seatbelt on macOS or bubblewrap on Linux, disables network, isolates
HOME/temp, protects Git metadata, and kills the process group on timeout/abort/overflow. Combined
output defaults to 16 MiB and cannot exceed 64 MiB.

`CrewArtifactStore` redacts full captured output before mode-`0600` storage, records SHA-256 and
byte count, revalidates integrity per read, and serves run-scoped UTF-8 byte ranges. Workspace diff
truncation fails closed.

## Architecture and files

`crew-runner*.service.ts`, `crew-stage-results.service.ts`,
`crew-build-finalizer.service.ts`, `crew-verifier.service.ts`,
`crew-command-{sandbox,runner}.ts`, `crew-review-evidence.service.ts`,
`crew-gate-evidence.service.ts`, `crew-artifact.store.ts`, and
`crew-attention.adapter.ts`.

## TDD evidence

Runner/stage/build/gate specs cover exact order, current-head evidence, same Builder, independent
caps, blocker/warning semantics, and strict final Reviewer. Verifier/artifact/review specs cover
sandbox failure, process outcomes, redaction, caps, integrity, cross-run denial, UTF-8 ranges, and
complete diffs. Session verify-owner specs keep Crew and Solo verification separate.

## Success criteria

- [x] Terminal success requires current green Verify and blocker-free Review.
- [x] No gate can be certified by model prose.
- [x] Full captured evidence is retained only within fail-closed bounds.
- [x] Frozen provider/model bindings are never changed by the runner.
- [x] Final aggregate and headless real-browser gates reconfirmed the fixed workflow.

## Risk and security

Artifact public metadata excludes storage path, command, and cwd. Secret redaction happens before
disk. Verify never runs unsandboxed.

## Next step

Phase 5 reconciles non-terminal work after process replacement and creates successors.
