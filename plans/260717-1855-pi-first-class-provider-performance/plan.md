# Pi first-class provider: performance and test plan

## Goal

Make Pi/Nuncio Engine cheaper to start and harder to regress without weakening the provider-neutral
contract, durable event ordering, or Pi SDK ownership. The UI smoothness ratchet and relay benchmark
are separate work; this plan changes only the Pi adapter, Pi-owned context loading, and Pi tests.

## Verified baseline

- `ExternalMemoriesService.buildForProject(..., "all")` calls Claude and Codex loaders; both run the same synchronous `git rev-parse` (`external-memories.ts:168-171`,
  `external-memory-sources.ts:55-74,193-232`). Measured median: about 16.9 ms.
- Pi registry creation is redundant but cheap (about 0.49 ms median); do not cache auth/model state in this pass. `DefaultResourceLoader` is expensive only on the first cold load (up to about 370 ms,
  then about 7.3 ms) and is cwd/context/tool-bound, so do not share it across sessions.
- Pi already maps token deltas into the shared durable-first path; base-provider tests pin the
  immediate head and 25 ms tail coalescing. Relay p50 is about 1.8 ms, so do not alter ADR-007.
- A successful tool-only `message_end` does not increment `assistantTurnsEmitted`, causing the
  fallback `"(no response)"` message (`pi-agent.provider.ts:398-405,744-771`).
- Real Pi integration currently prefers Opus/Sonnet and interrupts after a fixed 1.5 s sleep
  (`pi-agent.integration.spec.ts:20-25,298-335`).

## Phase 1 — RED: pin behavior and cost

1. In `pi-engine.external-memory-sources.spec.ts`, inject/override the Git-root resolver and assert Claude + Codex loads for the same Git project perform exactly one successful probe; later loads
   reuse it; another project probes once; memory files are still re-read after their content changes.
2. In `pi-agent.provider.spec.ts`, hold the mocked Pi prompt open and assert the first `assistant_delta` is already persisted and emitted with a positive `seq`; then send a 100-delta
   burst and assert exact reconstruction and event ordering after release.
3. Add a tool-only successful completion row: paired `tool_start/tool_end`, IDLE settlement, and no
   fabricated `assistant_message`. Preserve the legacy fallback when no `message_end` arrives.
4. Add interruption coverage driven by the first live Pi event: partial text/reasoning and an open
   tool are each retained/sealed once, the run settles IDLE, and callbacks after settlement cannot
   contaminate the next steer.
5. Run the focused tests and record the expected failures before production edits.

## Phase 2 — GREEN: minimal production changes

1. In `external-memory-sources.ts`, cache normalized project -> successful repository-root candidate resolution inside the singleton source service. Reuse it for both stores and later sessions, but
   never cache memory contents or failed probes; filesystem reads therefore remain fresh and a folder
   can still become a Git repo during the daemon lifetime.
2. In `pi-agent.provider.ts`, track “successful assistant completion observed” separately from “text message emitted.” Suppress the fallback after a successful textless/tool-only completion;
   keep it only for older SDK shapes with no terminal assistant event.
3. Close partial thinking/tool activity exactly once on abort/end and deactivate the completed turn's
   event sink so late SDK callbacks are ignored. Keep persistence-before-fanout and the existing
   active Pi session for resume; do not add Pi branches to shared session/UI code.
4. Refactor only within touched seams after green. Do not cache `AuthStorage`, `ModelRegistry`, or a
   project-bound `DefaultResourceLoader` until measurements show a material benefit.

## Phase 3 — real-Pi integration cleanup and performance evidence

1. In `pi-agent.integration.spec.ts`, prefer `anthropic:claude-haiku-4-5`, then other explicitly
   cheap available models, before proxy Sonnet/Opus fallbacks. Keep the real tool/cwd checks.
2. Replace the 1.5 s sleep with a bounded promise resolved by the first live delta/thinking/tool
   event, then interrupt immediately. A timeout is a clear failure; missing auth remains a skip.
3. Add an opt-in, report-only `perf:pi` harness using the same model, prompt, cwd, SDK version, and alternating order for vanilla Pi versus `PiAgentProvider`: one warm-up plus five trials, reporting
   cold setup, cold/warm time-to-first-delta, completion time, raw samples, median, and CV. It must
   fail only on invalid/missing evidence, not noisy latency. The deterministic Git-probe count is the
   merge gate; adopt a timing threshold only after two stable same-runner baselines.

## Docs, release, and verification

- Correct `README.md:452` and `docs/system-architecture.md:1795`: native Pi sessions are already
  file-backed and resume after daemon restart. Document the Pi perf command and cheapest-model rule
  in `docs/testing-and-verification.md`; add the report-only method to `docs/pi-engine.md`.
- User-visible startup/correctness improvement: add a **patch** changeset, e.g. “Improved Nuncio
  Engine startup and prevented tool-only Pi turns from showing a fake no-response message.”
- RED/green: `cd apps/server && bun test test/unit/agents/pi-agent.provider.spec.ts test/unit/agents/pi-engine.external-memory-sources.spec.ts`
- Adapter gate: `bun run --filter @nuncio/server test:integration` (real auth; skip is reported).
- Perf evidence: `bun run perf:pi -- --rounds 5 --write` (report-only).
- Final: `bun run check-changeset && bun run gate`; before PR, `bun run gate:full` and clean review.

## Done when

All RED rows pass; repeated all-mode memory loads issue one successful Git probe per project while
reading fresh content; first Pi delta is durable before prompt completion; tool-only and interrupted
turns are ordered, resumable, and free of synthetic/stale output; real-Pi tests are event-driven and
cheap-model-first; docs and patch changeset match shipped behavior.

## Unresolved questions

None.
