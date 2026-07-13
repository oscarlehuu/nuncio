# Docs manager report: transcript/runtime-prompt fix

Date: 2026-07-13
Scope: `README.md`, `docs/system-architecture.md`

## Updates

- Corrected provider runtime-awareness contract: Pi native `appendSystemPrompt`, Codex
  `developerInstructions`, Claude full native `appendSystemPrompt` with completed-query
  rebuild/resume on instruction-signature change, and Cursor SDK 1.0.22 first-message-only
  versioned bootstrap.
- Documented exact user-turn preservation for Pi, Codex, Claude, and all Cursor follow-ups.
- Updated transcript architecture to name shared `@nuncio/core` as projection owner.
- Documented exact legacy Pi suffix decoding before dedupe and narrow projection-only suppression
  for already-persisted matching augmented duplicates; append-only events remain unchanged.
- Documented immediate `steer_reserved` projection plus in-place accepted/queued reconciliation,
  including the reserved-block checkpoint guard and unchanged queued-steers panel UX.

## Docs impact

Minor. Existing runtime-awareness and transcript internals corrected; no route, Settings section,
surface ownership, or mobile parity changed. `docs/product-surfaces.md` intentionally unchanged.
No changelog/version edits.

## Verification

- Grounded wording in current provider, hydration, session, shared-core projection, and web parser
  source plus regression specs.
- Independent review found the decoder was broader than the documented suffix-only contract; the
  implementation owner corrected both decoders with regression coverage, then source was re-read.
- `git diff --check` passed.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Runtime-channel and transcript-projection docs now match implemented behavior.
**Concerns/Blockers:** None.
