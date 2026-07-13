# Code review: session transcript runtime prompt

Date: 2026-07-13
Scope: complete uncommitted diff on `fix/session-transcript-turn-order` against `origin/dev`

## Findings

No actionable findings. No blocker or warning found.

## Validation

- **CONFIRMED — provider continuity and exact user turns:** Cursor sends the deterministic bootstrap only while its provider handle is new, then sends follow-ups byte-exact (`apps/server/src/agents/providers/cursor-agent.provider.ts:182-195`). Claude sends exact user content, keeps full runtime instructions in native `appendSystemPrompt`, and rebuilds/resumes the persisted thread only when that instruction signature changes between completed turns (`apps/server/src/agents/providers/claude-agent.provider.ts:290-300`, `:478-526`, `:816-833`). Pi/Codex transport code is unchanged.
- **CONFIRMED — narrow compatibility decoding:** both decoders require either the versioned Cursor start marker plus exact request boundary or the complete legacy browser paragraph at the string tail (`apps/server/src/agents/runtime-user-prompt.ts:4-24`, `packages/core/src/transcript-user-prompt.ts:4-17`). Pi hydration normalizes before existing occurrence-count dedupe (`apps/server/src/pi-local/pi-transcript-hydrate.ts:29-36`; `apps/server/src/sessions/sessions.service.ts:1910-1952`). No SQLite row is rewritten.
- **CONFIRMED — append-only projection and ordering:** shared core suppresses a decoded polluted row only when an earlier non-queued canonical user block matches exactly, and does so before assistant/thinking flush (`packages/core/src/transcript-build-blocks.ts:394-409`). Reservation acceptance/queueing mutates the same keyed block in place (`packages/core/src/transcript-build-blocks.ts:421-475`).
- **CONFIRMED — incremental parser safety:** a reserved block prevents checkpointing until acceptance or queue reconciliation, so later reach-back mutation cannot corrupt a frozen prefix (`apps/web/src/lib/use-transcript-blocks.ts:18-33`). Batch/incremental equivalence coverage includes the new lifecycle.
- **CONFIRMED — queued-steer UX unchanged:** inline web transcript still filters queued blocks while the detail view derives its existing panel from event history (`apps/web/src/components/session-transcript.tsx:409`, `apps/web/src/components/session-detail.tsx:291`, `packages/core/src/transcript-build-blocks.ts:858-861`). Project-facts/HandoffBrief composition was not modified.
- **CONFIRMED — verification:** tester reports `bun run gate` green; final `bun run gate:full` green with 39 server e2e tests and level-5 Chrome smoke; `bun run check-changeset` and `git diff --check` green. The first full-gate attempt's transient `EADDRINUSE` passed in isolation and on complete retry.
- **CONFIRMED — docs/release scope:** patch changeset is appropriate for a user-visible bug fix (`.changeset/fixed-user-messages-appearing-late-or-exposing-n.md:1-5`). README and system architecture cover provider channels, compatibility projection, and reservation reconciliation. `docs/product-surfaces.md` correctly remains unchanged because no route, surface ownership, or parity contract changed.

## Unresolved questions

None.

**Status:** DONE
**Summary:** Final independent review found no actionable defect. Implementation preserves provider continuity, append-only history, narrow decoding, stable live-steer chronology, and existing queued-steer/project-context behavior.
**Concerns/Blockers:** None.
