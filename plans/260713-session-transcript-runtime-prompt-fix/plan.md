# Session transcript runtime-prompt fix

Status: complete
Priority: high
Target: `fix/session-transcript-turn-order` -> `dev`

## Goal

Fix delayed live-steer bubbles, stop runtime/system context being resent as user prose, and hide only proven Nuncio-generated legacy duplicates without rewriting append-only events.

## Locked invariants

- Pi/Codex keep exact user input plus native `appendSystemPrompt`/`developerInstructions`; preserve project-facts/HandoffBrief composition.
- Claude puts the full current runtime instructions in native `appendSystemPrompt`; user content stays exact.
- Cursor SDK 1.0.22 has no system/developer channel: send one deterministic versioned Nuncio bootstrap envelope on the first provider message only; later turns stay exact.
- Existing SQLite events remain untouched. Suppress only a candidate that deterministically equals an earlier canonical user/steer plus the exact legacy Nuncio browser-runtime suffix, or decodes from the versioned Cursor envelope.
- `steer_reserved` is an immediate optimistic user projection reconciled in place by `steer_message` or `steer_queued`; web queued steers remain panel-only.

## Phase 1 — red tests

- [ ] Add failing reservation/reconciliation and legacy-duplicate cases in `packages/core/src/transcript-build-blocks.spec.ts`: stable key/order, no duplicate, queued fallback, genuine later user text preserved.
- [ ] Add failing provider cases in `apps/server/test/unit/agents/cursor-agent.provider.spec.ts` and `claude-agent.provider.spec.ts`: first Cursor send enveloped once, follow-up exact; Claude user text exact and full native system prompt refreshed safely.
- [ ] Strengthen `pi-agent.provider.spec.ts` and `codex-agent.provider.spec.ts` characterization for exact initial/follow-up text and native context channels.
- [ ] Add import/reconciliation regressions in `apps/server/test/unit/pi-local/pi-transcript-hydrate.spec.ts`, `sessions.live-watch-dedup.spec.ts`, and `sessions.steer-running.spec.ts`: old Pi augmented rows append zero, refresh stays idempotent, reservation is visible before live steer settles.
- [ ] Add `apps/web/src/components/session-transcript.spec.tsx` proof that a reservation renders immediately and does not move/duplicate; keep `session-detail.spec.tsx` queued-panel assertion unchanged.

## Phase 2 — provider prevention

- [ ] Add a small deterministic transport helper under `apps/server/src/agents/` for versioned Cursor bootstrap encode/decode and exact legacy Nuncio suffix recognition.
- [ ] Update `cursor-agent.provider.ts`: envelope only when creating/sending the first message on a provider handle; reuse handle with byte-exact later messages and unchanged runtime tools.
- [ ] Update `claude-agent.provider.ts`: render full runtime instructions into `appendSystemPrompt`, remove runtime text from `buildUserMessage`, and track a runtime-context signature.
- [ ] When Claude context changes between completed turns, retire the live query and resume its persisted thread with the refreshed native system append; preserve policy/tool refresh, approvals, attachments, and cancellation safety.
- [ ] Do not change Pi/Codex transport behavior or first-prompt project-facts composition.

## Phase 3 — hydration and shared projection

- [ ] Decode only the versioned Nuncio provider envelope at import boundaries; preserve ordinary user headings/text.
- [ ] Normalize dedupe identity in `sessions.service.ts` so a hydrated old-Pi candidate matching an existing canonical row plus the exact browser-runtime suffix is not appended or announced as refreshed.
- [ ] Update `packages/core/src/transcript-build-blocks.ts` before assistant flushing: ignore only deterministic matching polluted rows already persisted at the tail; never delete/mutate durable history.
- [ ] Fold `steer_reserved` into a pending user block after the current partial assistant output; mutate that same block to accepted or queued so chronology and key stay stable.
- [ ] Confirm web filtering still removes only queued blocks and mobile/shared consumers inherit the corrected order without provider-specific branches.

## Phase 4 — verification and delivery

- [ ] Run focused core, provider, Pi hydration/watch, session steer, web transcript, and unchanged queued-panel specs; require red -> green evidence.
- [ ] Run server/core/web/mobile build, lint, and tests; then `bun run gate`, `bun run gate:full`, and `bun run test:smoke-ui` with real Chrome.
- [ ] Real-browser acceptance: live steer appears before provider acceptance settles; final transcript has one stable user bubble; seeded legacy Pi sequence shows user -> assistant only and no runtime manifest/browser instruction.
- [ ] Run optional real Pi/Claude/Codex integrations only when credentials are available; report skips separately.
- [ ] Update `README.md` and `docs/system-architecture.md` for native context channels, Cursor bootstrap provenance, hydration compatibility, and reservation projection. Update `docs/product-surfaces.md` only if surface parity/contract changes.
- [ ] Add a patch changeset from the user perspective, run `bun run check-changeset`, `git diff --check`, then independent code review; fix blockers before commit/PR.

## Unresolved questions

None.

## Completion

- Focused regressions, `bun run gate`, `bun run gate:full`, server e2e, and level-5 Chrome smoke passed.
- Independent code review found no actionable findings.
