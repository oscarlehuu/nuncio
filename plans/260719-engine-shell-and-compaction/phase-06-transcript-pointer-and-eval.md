# Phase 06 — Transcript pointer tool + integration/eval (Track B)

## Context links

- `apps/server/src/crew/crew-runtime-tools.service.ts` — `read_crew_artifact` bounded-range read
  pattern to mirror.
- `apps/server/src/sessions/persistence/events.repository.ts` — the durable event log (seq cursor)
  the tool reads.
- `eval:extract` harness; doc principle 4 (Engine must beat vanilla or a layer does not ship).

## Overview

Priority: medium. Two closers for Track B:

1. **`read_session_history` engine tool** (locked decision 8): lets the model re-read compacted
   history from the SQLite event log — bounded range by seq cursor, filtered event types, hard
   output cap. This is the Grok Build `<transcript_location>` idea with a better substrate (Nuncio
   already owns a durable, seekable transcript).
2. **Prove it, then flip the default:** gated integration test + eval replay vs Pi default
   compaction.

## Requirements

- Tool input: `{ sinceSeq?, untilSeq?, types?, limit? }`; output bounded (reuse persistence
  truncation limits); read-only; registered on the engine tool belt for solo Engine sessions
  (crew-internal exposure deferred with Crew compaction).
- Integration (gated, real model): drive a session past the compaction threshold; assert the
  survivors block appears verbatim in the post-compaction context and the session continues
  correctly on the pinned plan.
- Eval: replayed long-session tasks, Engine-compaction ON vs OFF; continuation-quality metrics
  (task completion, wrong-direction turns, tokens). Win/tie → flip `NUNCIO_ENGINE_COMPACTION`
  default to `on` (separate tiny PR + changeset); loss → stays opt-in, findings reported.

## Related code files

- **Create:** `apps/server/src/agents/pi-engine/read-session-history-tool.ts` (+ spec)
- **Edit:** engine tool belt registration in `pi-agent.provider.ts`
- **Extend:** `test/integration/pi-agent.integration.spec.ts` (compaction survivors round-trip)
- **Report:** `plans/reports/eval-260719-engine-compaction.md`

## Implementation steps (TDD)

1. Red: tool specs — range reads, type filter, caps, unknown session/seq handled cleanly. Green.
2. Gated integration: real compaction round-trip with survivors assert.
3. Eval run + report; default-flip decision with user.

## Todo

- [ ] Tool + specs
- [ ] Gated integration round-trip
- [ ] Eval report + default decision
- [ ] Changeset (patch): "The Nuncio Engine can re-read earlier conversation history that was
      compacted away, instead of losing it."
