# Debugger report: transcript turn order + runtime prompts

## Verdict

Supplied causal chain is **confirmed for legacy Pi rows downstream**, but **refuted as a current Pi prompt-generation bug**.

- Current Pi sends exact user text and installs Nuncio guidance through `appendSystemPrompt`; its regression test passes.
- A legacy/externally persisted Pi user row containing `clean text + Nuncio guidance` still bypasses exact-text reconciliation, is appended after the completed turn, then renders as a second user bubble.
- Current Claude and Cursor still mutate every provider user turn. Codex and Pi do not.

## Evidence

### 1. Why the late user bubble appears — CONFIRMED

1. Shared provider code persists the clean initiating input before invoking the SDK: `apps/server/src/agents/agents.base-provider.ts:639-661`.
2. Pi hydration maps the complete persisted `role=user` text directly to `user_message`, with no Nuncio-envelope normalization: `apps/server/src/pi-local/pi-transcript-hydrate.ts:23-31`, `:86-95`.
3. `getEvents()` refreshes provider transcripts before returning events: `apps/server/src/sessions/sessions.service.ts:227-248`.
4. Refresh computes missing events and appends them at the current DB tail: `apps/server/src/sessions/sessions.service.ts:1748-1765`.
5. Reconciliation collapses `steer_message` into the user family but keys messages by **exact text**. Clean text and augmented text are different keys, so the hydrated row is appended: `apps/server/src/sessions/sessions.service.ts:1910-1952`.
6. The shared parser treats every `user_message`/`steer_message` as visible user content. Its duplicate guard is also exact-text only: `packages/core/src/transcript-build-blocks.ts:382-427`. Therefore the augmented row renders at its newly appended tail position, including guidance.

This explains all three visible symptoms from one projection defect: duplicate row, wrong end position, exposed guidance.

### 2. Current Pi future-turn behavior — supplied claim REFUTED

- `SessionsService` always constructs and passes `runtimeEnvironment`: `apps/server/src/sessions/sessions.service.ts:2024-2067`.
- Pi calls `handle.prompt(text, ...)` unchanged when that environment exists: `apps/server/src/agents/providers/pi-agent.provider.ts:325-367`.
- Pi installs the full runtime envelope in the resource loader's `appendSystemPrompt`: `apps/server/src/agents/providers/pi-agent.provider.ts:469-518` and `:530-537`.
- Existing test explicitly asserts exact user prompt plus system-prompt guidance: `apps/server/test/unit/agents/pi-agent.provider.spec.ts:630-660`.

Thus a newly produced augmented Pi row is not explained by current Nuncio source. Most likely source is a Pi row persisted by an older runtime (before current exact-prompt behavior), an external handoff, or undocumented Pi SDK persistence behavior. Supplied raw-row observation is compatible with the downstream bug, but creation time/runtime version remains unverified under the no-DB-read constraint.

### 3. Current cross-provider prompt mutation

- **Claude — CONFIRMED mutation:** static core identity is system prompt (`apps/server/src/agents/providers/claude-agent.provider.ts:458-519`), but every initial, follow-up, and live redirect passes through `buildUserMessage()` (`:272-299`, `:306-342`), which appends capability manifest/tool guidance to user text (`:809-827`). The test locks this behavior: `apps/server/test/unit/agents/claude-agent.provider.spec.ts:507-552`.
- **Cursor SDK — CONFIRMED mutation:** every `agent.send()` prepends full runtime instructions and `## User request`: `apps/server/src/agents/providers/cursor-agent.provider.ts:137-185`. Test expects that wrapper: `apps/server/test/unit/agents/cursor-agent.provider.spec.ts:462-511`.
- **Codex — clean:** turn input stays exact while runtime guidance uses `developerInstructions`: `apps/server/src/agents/providers/codex-agent.provider.ts:306-347`, `:407-443`.
- **Pi — clean:** exact turn text + resource-loader system prompt, cited above.

Nuncio UI exposure is currently Pi-specific for this report: transcript refresh reads Pi session files and Cursor **CLI handoff** transcripts only, not Claude or Cursor SDK provider histories (`apps/server/src/sessions/sessions.service.ts:1768-1776`). Claude/Cursor mutation is still undesirable provider-history pollution and repeated prompt overhead.

## Minimal fix boundaries

1. **Prevent duplicate import:** in `missingTranscriptEvents`, treat a hydrated user row as the same logical event when it equals an existing clean user/steer text plus a recognized Nuncio-owned runtime-envelope suffix. Require the clean prefix match; do not globally strip headings.
2. **Clean already-persisted legacy projection:** in shared transcript parsing, detect that same clean-prefix + recognized-envelope duplicate **before** flushing assistant/thinking buffers, then ignore it. This restores order and hides guidance without rewriting SQLite history.
3. **Provider prevention:** keep Pi and Codex unchanged. Move Claude's full envelope to its supported system channel and send exact text for initial/follow-up/redirect messages. For Cursor, first verify whether the installed SDK exposes a durable system/developer-instructions channel; do not invent a bootstrap user turn.
4. **Do not touch project facts:** initial project facts intentionally enter the composed user prompt at `apps/server/src/sessions/sessions.service.ts:319-327`. Pi also independently builds project context into system resources at `apps/server/src/agents/providers/pi-agent.provider.ts:416-445`. Cleanup must match only the Nuncio runtime-envelope marker and an existing clean input, never generic markdown/system-looking content.

Avoid a broad DB migration or generic substring stripping. Both risk deleting intentional repeated messages or project facts.

## TDD cases

1. `sessions.live-watch-dedup.spec.ts`: DB has clean `steer_message`; Pi transcript has assistant then `clean + runtime manifest`; refresh adds zero rows and no `transcript_refreshed`.
2. `transcript-build-blocks.spec.ts`: clean user -> assistant -> already-persisted augmented duplicate projects as `[user, assistant]`; guidance absent and assistant order unchanged.
3. Negative parser/reconciliation cases: preserve an intentional resend; preserve standalone text containing the marker; preserve project-facts preamble; only suppress when a prior clean user/steer is the exact prefix.
4. Pi provider: add settled follow-up steer coverage asserting both SDK prompt calls are exact; runtime envelope remains in loader system prompt.
5. Claude provider: initial, settled follow-up, and priority-now redirect all carry exact user text; full runtime envelope remains available through the non-user channel.
6. Cursor provider: equivalent exact-text tests only after confirming a real SDK instruction channel; otherwise record the provider limitation explicitly.
7. Codex provider: retain exact turn input + `developerInstructions` regression coverage.

## Verification

Ran from `apps/server`:

`bun test test/unit/agents/pi-agent.provider.spec.ts test/unit/agents/claude-agent.provider.spec.ts test/unit/agents/cursor-agent.provider.spec.ts test/unit/sessions/sessions.live-watch-dedup.spec.ts`

Result: **130 pass, 0 fail**. Existing green tests confirm current behavior; no test currently covers an augmented hydrated user row against a clean live row.

## Unresolved questions

1. Was the supplied augmented Pi row created before commit `374ea90b`, by an external Pi handoff, or by current Pi SDK persistence despite exact `prompt()` input?
2. Does the pinned Cursor SDK offer a supported system/developer instruction channel with continuity across resumed turns?
3. For Claude, must capability-manifest changes take effect mid-session, or is rebuilding the query/session acceptable when the envelope changes?

**Status:** DONE
**Summary:** Confirmed exact-text hydration/projection as cause of late visible legacy Pi guidance; current Pi prevention already clean; Claude/Cursor still mutate each turn.
**Concerns/Blockers:** Cursor non-user instruction support and origin/runtime version of the observed Pi row need confirmation before provider-wide implementation.
