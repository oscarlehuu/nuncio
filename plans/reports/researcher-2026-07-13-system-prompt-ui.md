# System prompt injection and transcript turn-order research

Date: 2026-07-13  
Scope: read-only, current `origin/dev` (`374ea90b`)  
Tests run: none; research only

## TL;DR

The reported turn has three coupled defects:

1. **Runtime context is encoded as user text in some provider transports.** Current Pi and Codex correctly use system/developer channels, but Cursor SDK and Claude still concatenate runtime context into `role: user` content.
2. **Pi transcript hydration cannot distinguish canonical user input from transport-expanded input.** Exact-text dedupe therefore imports an expanded prompt as a second user event.
3. **Refresh appends that historical duplicate at the event-log tail.** The shared parser treats it as a new turn after the assistant reply, producing wrong turn order and exposing the runtime envelope in web/mobile.

The web and mobile renderers are not independently generating the bad text. Both faithfully render the same shared `@nuncio/core` projection. Fix the provider/hydration boundary first; add a narrow shared projection compatibility guard only for already-persisted polluted events.

## Locked constraints

- Keep provider-neutral session schema and shared event/UI contract: `docs/product-vision.md:36-44`, `docs/architecture-decisions.md:35-60`.
- Keep transcript behavior in shared core before shell-specific changes: `docs/product-surfaces.md:101-109`.
- Preserve append-only durable events and provider adapters behind `AgentProvider`; do not add provider-specific UI branches.
- Preserve current verified Pi `appendSystemPrompt` and Codex `developerInstructions` behavior. They are desired context injection, not visible transcript content.

## Trace: context creation to provider transport

### Provider-neutral runtime envelope

- `apps/server/src/agents/runtime-environment.ts:13-21` defines static Nuncio identity/instructions.
- `apps/server/src/agents/runtime-environment.ts:46-63` renders either the full runtime instructions or per-turn manifest/tool context.
- `apps/server/src/agents/runtime-environment.ts:165-182` renders the authoritative session/provider/model/cwd/tools/capabilities manifest.
- `apps/server/src/sessions/sessions.service.ts:2005-2068` builds registered/policy-scoped tools plus `nuncio_runtime_info`, then supplies `runtimeEnvironment` to every provider run/steer.
- `apps/server/src/agents/agents.base-provider.ts:626-661` persists the caller's raw text as `user_message`/`steer_message` before provider execution. This canonical durable event is clean by design.

### Pi: current behavior is correct

- `apps/server/src/agents/providers/pi-agent.provider.ts:325-367` sends the exact raw user text to Pi when `runtimeEnvironment` exists.
- `apps/server/src/agents/providers/pi-agent.provider.ts:416-447` combines project facts/HandoffBrief context with runtime instructions and passes it through `DefaultResourceLoader({ appendSystemPrompt: [...] })`.
- `apps/server/src/agents/providers/pi-agent.provider.ts:450-518` does the same for policy-scoped runs.
- `apps/server/test/unit/agents/pi-agent.provider.spec.ts:630-660` explicitly locks the clean user prompt plus system-prompt append.
- `apps/server/src/agents/pi-engine/nuncio-context.ts:75-100,108-150` keeps facts first, adds only the latest valid scoped HandoffBrief, and remains bounded.

Dependency verification: Pi's resource loader resolves `appendSystemPrompt`, `AgentSession` joins it, then `buildSystemPrompt` installs it as system context. It is not emitted as a user message. Evidence: installed `@earendil-works/pi-coding-agent` `dist/core/resource-loader.js:334-341`, `dist/core/agent-session.js:694-723`, and `dist/core/system-prompt.js`.

### Codex: current behavior is correct

- `apps/server/src/agents/providers/codex-agent.provider.ts:306-347` sends raw user input to `turn/start`.
- `apps/server/src/agents/providers/codex-agent.provider.ts:407-443` supplies rendered runtime instructions via `developerInstructions` on thread start/resume.
- `apps/server/test/unit/agents/codex-agent.provider.spec.ts:782-828` verifies resumed developer instructions and exact raw `Continue` turn input.

### Cursor SDK: current role contamination

- `apps/server/src/agents/providers/cursor-agent.provider.ts:137-185` renders full runtime instructions, concatenates `## User request\n${text}`, and sends the whole string through `agent.send(...)` as user input.
- `apps/server/test/unit/agents/cursor-agent.provider.spec.ts:462-515` currently expects the injected manifest/tool context inside the sent prompt; this test preserves the defect rather than preventing it.
- Installed Cursor SDK types expose `agent.send(message, options)` but no evident system/developer-instruction option. Implementation must verify official/runtime support before assuming a native channel exists.

### Claude: current role contamination

- `apps/server/src/agents/providers/claude-agent.provider.ts:458-525` correctly places static Nuncio identity in `appendSystemPrompt`.
- `apps/server/src/agents/providers/claude-agent.provider.ts:809-827` nevertheless appends the dynamic runtime manifest/tool context to `text` and emits it as `message.role = 'user'` on initial prompts and steers.
- `apps/server/test/unit/agents/claude-agent.provider.spec.ts:507-552` currently expects this split, including manifest/tool instructions in received user text.

Historical note: before `origin/dev@374ea90b`, Pi and Codex also appended runtime/tool text to user prompts. Current code prevents new Pi/Codex contamination but cannot repair provider session files or SQLite events created by older builds.

## Trace: provider transcript to visible wrong turn

### Hydration loses provenance

- `apps/server/src/pi-local/pi-transcript-hydrate.ts:19-31` maps every Pi `role: user` message directly to `user_message`.
- `apps/server/src/pi-local/pi-transcript-hydrate.ts:86-95` joins and trims all text blocks. There is no recognition of a Nuncio-owned envelope, `## User request`, runtime manifest, or system append.
- `apps/server/src/sessions/sessions.service.ts:1768-1776` hydrates only Cursor CLI and Pi transcripts. Thus the immediate visible bug is most plausibly a Pi session created under the older transport behavior; current Cursor SDK/Claude remain model-channel defects but do not use this hydration path.

### Exact dedupe misses the expanded prompt

- `apps/server/src/sessions/sessions.service.ts:1910-1952` canonicalizes steer/user families but keys messages by exact text.
- Existing canonical event: `user_message:do X`.
- Hydrated historical provider event: `user_message:<runtime envelope> ... do X`.
- The keys differ, so the hydrated event is considered missing and appended.
- Existing coverage only proves exact-text dedupe: `apps/server/test/unit/sessions/sessions.live-watch-dedup.spec.ts:145-180`, `apps/server/test/unit/sessions/sessions.steer-running.spec.ts:558-574`, and plain hydration in `apps/server/test/unit/pi-local/pi-transcript-hydrate.spec.ts:3-33`. None covers a provider-expanded user prompt.

### Append-at-tail causes false turn order

- `apps/server/src/sessions/sessions.service.ts:1738-1765` imports an empty transcript in source order, but refresh computes missing events and `appendBatch` adds them at the durable log tail.
- Concrete sequence:
  1. seq 1: canonical raw user prompt
  2. seq 2: live assistant response
  3. refresh reads expanded historical user + same assistant
  4. assistant exact-dedupes; expanded user does not
  5. expanded user is appended as seq 3
- Result: `user -> assistant -> polluted user`, although that final user entry belongs to the first turn.

### Shared projection exposes it in both shells

- `packages/core/src/transcript-build-blocks.ts:382-427` flushes assistant/thinking on every user event, only suppresses exact repeated user text, then pushes differing text as a new user block.
- Therefore the expanded seq-3 event both displays the hidden envelope and resets the turn boundary.
- `apps/web/src/lib/transcript-build-blocks.ts:1`, `apps/web/src/components/session-transcript.tsx:9-13,238-264`, and `apps/web/src/components/transcript-bubbles.tsx:29-52` show web uses core and renders user text verbatim.
- `apps/mobile/src/lib/use-transcript-blocks.ts:1-16`, `apps/mobile/src/app/session/[id].tsx:42-44,169-183`, and `apps/mobile/src/components/transcript-block-view.tsx:46-51` show mobile does the same.

## Recommended fix boundary

1. Keep the durable Nuncio event's user/steer text byte-for-byte equal to caller input.
2. Keep Pi runtime/project/HandoffBrief context in `appendSystemPrompt`; keep Codex context in `developerInstructions`.
3. For Claude, move dynamic runtime context to a supported system/developer channel if the SDK permits safe updates across resume/steer. Do not repeat it as generic user prose.
4. For Cursor SDK, first verify whether the current SDK/runtime supports a system/developer channel. If not, use a deterministic, versioned Nuncio transport envelope with explicit provenance and a shared decoder at import boundaries; never treat that envelope as canonical user text.
5. Sanitize Nuncio-owned historical Pi transport wrappers before hydration/dedupe. Match exact versioned structure or compare against a known canonical raw event; do not broadly strip user text merely because it contains a familiar heading.
6. Prevent semantic duplicates before `appendBatch`; this fixes both duplicate visibility and wrong ordering for this defect.
7. For already-persisted polluted SQLite rows, prefer a narrow projection compatibility filter over deleting append-only history. A one-time data rewrite needs an explicit product decision.
8. Do not fix this separately in web and mobile. Both should inherit the shared event/core correction.

## Red-first regression matrix

### Provider adapters

- Pi: extend `pi-agent.provider.spec.ts` to cover initial run and steer/recreated handle; user prompt stays exact while system append contains runtime/project context.
- Codex: cover thread start and resume; `turn/start` input stays exact while `developerInstructions` carries runtime context.
- Cursor SDK and Claude: replace tests that normalize role contamination. Assert raw user input if a native context channel exists; otherwise assert a tagged transport envelope plus lossless decode before hydration/projection.
- Shared provider conformance: for every provider, persisted `user_message`/`steer_message` text equals input byte-for-byte.

### Hydration and reconciliation

- `pi-transcript-hydrate.spec.ts`: historical expanded prompt hydrates to raw user text once; repeat for steer; similar user-authored headings are preserved.
- `sessions.live-watch-dedup.spec.ts`: with existing `[raw user, assistant]` and hydrated `[expanded same user, same assistant]`, refresh appends zero user events, emits no false transcript refresh, preserves order, and remains idempotent on a second refresh.
- Empty-DB handoff case: imports sanitized raw input and assistant once, in source order.

### Shared core and shells

- `packages/core/src/transcript-build-blocks.spec.ts`: if legacy compatibility suppression is selected, `[raw user, assistant, matching Nuncio wrapper user]` projects to `[raw user, assistant]` without a new turn boundary. A genuine later user turn must remain visible.
- Web component regression: injected runtime header absent and user/assistant DOM order correct.
- Mobile: shared core coverage is primary; add a lightweight component/projection assertion if the current mobile harness supports it. Avoid duplicate shell parsing rules.

## Verification target

Run the narrow server/provider/hydration/core tests first, then `bun run gate`. Because live Pi transcript refresh is the integration boundary, also exercise a deterministic Pi session-file fixture through `SessionsService`. For visible behavior, seed the bad legacy sequence and verify the real browser shows one user bubble followed by its assistant response, with no runtime manifest text.

## Unresolved questions

1. Which provider and app version produced the reported session? This determines whether it is historical Pi/Codex contamination or a current Cursor/Claude transport issue, and whether legacy DB compatibility is required immediately.
2. Should existing polluted durable events be hidden only at projection time, or explicitly migrated? Append-only ADR makes this a product/data-retention decision.
3. Does the installed Cursor SDK have an undocumented supported system/developer-instruction path? Current public types do not show one; verify before implementation.

**Status:** DONE
**Summary:** Traced runtime context through all providers, Pi hydration, dedupe, shared core, web, and mobile. Confirmed three linked defects and defined provider-neutral red tests/fix boundaries.
**Concerns/Blockers:** Implementation needs the originating provider/version and a decision on legacy persisted-event handling; neither blocks the diagnosis.
