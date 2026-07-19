# Phase 04 — Compaction contract spec + survivors builder (Track B)

## Context links

- Pi SDK 0.80.10 `dist/core/extensions/types.d.ts` — `SessionBeforeCompactEvent { preparation,
  branchEntries, reason: 'manual'|'threshold'|'overflow', willRetry }` /
  `SessionBeforeCompactResult { cancel?, compaction?: CompactionResult }`.
- Pi `dist/core/compaction/compaction.js` — trigger (`contextWindow - reserveTokens`), tail-keep
  cut points, incremental summary + file-ops ledger (all stays Pi-owned).
- 2026-07-19 comparison: Grok Build skeleton principle — *what must survive is re-injected
  verbatim, never delegated to the summarizer*.

## Overview

Priority: high (foundation of Track B). Two independent deliverables, no behavior change yet:

1. **Contract spec** pinning the exact SDK surface the compaction layer will ride — the maintenance
   answer: a Pi version bump that changes the hook contract turns the gate red loudly instead of
   breaking silently (pattern: `pi-agent.cwd.spec.ts`, `design-tokens.spec.ts`).
2. **Survivors snapshot builder** — provider-neutral pure module deriving the pinned-state block
   from the durable event log: latest `plan_updated`, latest verify result, open chips, repro-gate
   state, nuncio-context facts. Any future engine reuses it (shared-first).

## Requirements

- Contract spec asserts (against the installed SDK's real exports/types): hook name registration
  shape, event fields used (`preparation`, `branchEntries`, `reason`, `willRetry`), result fields
  produced (`compaction.summary`, `compaction.firstKeptEntryId`, `tokensBefore`, `details`).
- Survivors builder: pure function `(events) → SurvivorsBlock` with per-section hard budgets and a
  deterministic priority order (plan > verify > repro-gate > chips > facts) when over budget;
  stable text rendering (byte-identical for identical inputs).

## Related code files

- **Create:** `apps/server/test/unit/agents/pi-engine/compaction-contract.spec.ts`
- **Create:** `apps/server/src/sessions/domain/session-state-snapshot.ts` (+ spec under
  `test/unit/sessions/`)

## Implementation steps (TDD)

1. Red: contract spec fails against a deliberately wrong shape; green against the real SDK.
2. Red: survivors specs — each source event type extracted; latest-wins semantics; budget
   overflow drops lowest priority section first; empty log → empty block (not an error).
3. Green: implement; no wiring anywhere yet.

## Todo

- [ ] Contract spec (red → green)
- [ ] Survivors builder + specs
- [ ] No changeset (tests + internal module only, `<!-- no-changeset -->`)
