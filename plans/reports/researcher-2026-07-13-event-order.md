# Event-order investigation

Read-only. Evidence rebased to latest `origin/dev` at `374ea90b` (runtime-environment merge), not stale worktree HEAD `213e7a14`. Runtime-aware provider changes alter system/tool context, not session-event ordering.

## TL;DR

No durable-log, WS replay, bootstrap-merge, or `seq` sorting defect found. Primary confirmed defect: Pi/Claude live steer first commits and broadcasts text as `steer_reserved`, but shared transcript folding ignores that event. User bubble appears only when later `steer_message` lands. Separate queued behavior: web intentionally hides `steer_queued` bubbles from conversation and shows queue panel; mobile renders them inline but in unstable/wrong interim order.

## Exact event paths

### Create

1. `SessionsService.create()` stores row, starts run fire-and-forget, returns session: `apps/server/src/sessions/sessions.service.ts:329-349`.
2. shared `BaseAgentProvider.runOrSteer()` commits `status:RUNNING`, then `user_message`, then waits until pending events persist before SDK work: `apps/server/src/agents/agents.base-provider.ts:639-661`.
3. provider emits assistant/thinking/tool events.
4. shared base commits `status:IDLE`: `apps/server/src/agents/agents.base-provider.ts:669-675`.

Expected durable order: `status(RUNNING) -> user_message -> assistant/... -> status(IDLE)`.

### Steer while IDLE/PAUSED/ERROR

1. `SessionsService.steerInternal()` resolves provider, calls and awaits `provider.steer()`: `apps/server/src/sessions/sessions.service.ts:618-668`.
2. shared base uses same path as create, but commits `steer_message` before `executePrompt()`: `apps/server/src/agents/agents.base-provider.ts:626-661`.
3. REST/WS RPC response waits for provider turn completion (`sessions.service.ts:650-668`; WS `apps/server/src/sessions/api/sessions.ws.ts:310-320`). This makes send state long-lived, but is not ordering root when relay healthy: the committed `steer_message` is broadcast before the response.

Expected durable order: `status(RUNNING) -> steer_message -> assistant/... -> status(IDLE)`.

### Steer while RUNNING — live-capable provider

1. service calls `provider.steerMidRun()`: `apps/server/src/sessions/sessions.service.ts:604-608,694-715`.
2. Pi commits `steer_reserved`, waits persistence, awaits SDK `session.steer()`, then commits `steer_message`: `apps/server/src/agents/providers/pi-agent.provider.ts:204-254`.
3. Claude commits `steer_reserved`, waits persistence, pushes priority-now input, then commits `steer_message`: `apps/server/src/agents/providers/claude-agent.provider.ts:306-350`.

`steer_reserved` is deliberate durable input intent, earlier than SDK acceptance. Pi can have a material gap because line 242 is awaited. Claude's gap is normally short. Existing recovery tests prove reservation can exist without `steer_message` when current turn ends during recovery: Pi spec `apps/server/test/unit/agents/pi-agent.provider.spec.ts:745-782`; Claude spec `apps/server/test/unit/agents/claude-agent.provider.spec.ts:194-236`.

### Steer while RUNNING — queued provider/fallback

1. service persists queue row plus `steer_queued`: `apps/server/src/sessions/sessions.service.ts:604-612,726-733`.
2. foreground run commits `status:IDLE`; service schedules queue drain: `apps/server/src/sessions/sessions.service.ts:2113-2141`.
3. drain invokes normal `steer()`: `apps/server/src/sessions/sessions.service.ts:944-1017`.
4. normal base path commits `status:RUNNING -> steer_message -> assistant/... -> status:IDLE`.

Queue order is intentionally turn-sequential, unlike live steer.

## Server/transport audit: not the reorder source

- Events allocate next per-session `seq`, insert, then notify: `apps/server/src/sessions/persistence/events.repository.ts:148-175`. Reads are `ORDER BY seq ASC`: `:32-45`.
- Base non-delta events flush buffered deltas first, persist, then emit: `apps/server/src/agents/agents.base-provider.ts:205-250`.
- `SessionsService.onAgentEvent()` fans out the already-persisted `seq`: `apps/server/src/sessions/sessions.service.ts:2113-2135`.
- WS installs live subscription before replay, buffers live arrivals during replay, sorts pending live by `seq`, dedupes via high-water: `apps/server/src/sessions/api/sessions.ws.ts:213-285`.
- Web merges live/REST pages by `seq` and sorts: `apps/web/src/lib/use-session-stream.ts:27-38`; late bootstrap is merged, never replaces: `:135-148,185-202`.
- Mobile does same merge/sort: `apps/mobile/src/lib/use-session-transcript.ts:20-31,166-180`.
- Latest `origin/dev` browser pooling preserves per-consumer monotonic cursor and only delivers increasing `seq`: `packages/core/src/session-relay-shared-connection.ts:103-115`; shared-channel replay starts at minimum consumer cursor: `:138-165`.

Conclusion: persisted/broadcast/client arrays remain monotonic. Defects begin in event-to-block projection/presentation.

## Findings

### 1. CONFIRMED — live `steer_reserved` text is invisible to every transcript

Shared parser handles only `user_message | steer_message` as accepted user bubbles and `steer_queued` as queued bubbles: `packages/core/src/transcript-build-blocks.ts:382-438`. No `steer_reserved` branch exists through `stepEvent()` (`:382-772`). Therefore committed/broadcast intent is silently discarded until `steer_message`.

Empirical pure-parser probe:

```text
[user_message, assistant_delta, steer_reserved]
=> [user("first"), assistant("working")]

... + steer_message
=> [user("first"), assistant("working"), user("change")]
```

This exactly explains live-steer symptom, especially Pi while awaited SDK acceptance delays line 246.

Likely fix boundary: provider-neutral `packages/core` fold. Treat reservation as visible pending user intent; reconcile later `steer_message` (accepted) or `steer_queued` (fallback) in place, without duplicate or tail jump. Do not add provider-specific UI branches.

### 2. CONFIRMED behavior, product-dependent defect — queued steer intentionally absent from web conversation

Parser creates a queued user block: `packages/core/src/transcript-build-blocks.ts:430-438`. Web transcript explicitly removes it: `apps/web/src/components/session-transcript.tsx:405-413`. Full session shows text in queue panel above composer instead: `apps/web/src/components/session-detail.tsx:289-292,871-876`; panel contract says “rather than scattered inline”: `apps/web/src/components/queued-steers-panel.tsx:14-25`.

Existing test locks this current policy: `apps/web/src/components/session-detail.spec.tsx:1093-1106` (“panel above composer, not inline”). Thus “queued message appears in conversation only after current turn finishes” is expected current web behavior, not transport loss.

Decision boundary: if requirement is specifically live steer, leave queue UX alone. If requirement is “every submitted user message appears immediately in conversation,” this is a separate intentional UX reversal; update panel/inline contract explicitly.

### 3. CONFIRMED — mobile queued bubble has unstable interim order and no queued affordance

For `assistant_delta -> steer_queued`, parser deliberately does not flush assistant buffer (`packages/core/src/transcript-build-blocks.ts:430-438`), while `finalizeBlocks()` appends streaming assistant tail after committed blocks (`:780-797`). Result:

```text
[user("first"), assistant_delta("working"), steer_queued("later")]
=> [user("first"), user queued("later"), assistant streaming("working")]
```

When delivered, `steer_message` flushes assistant, removes queued block, then appends accepted user at tail: `packages/core/src/transcript-build-blocks.ts:386-423`. Bubble jumps from before current assistant to after it.

Web masks this via filtering. Mobile feeds all blocks directly to `FlatList` (`apps/mobile/src/app/session/[id].tsx:169-184`) and renders queued user exactly like accepted user, ignoring `block.queued`: `apps/mobile/src/components/transcript-block-view.tsx:46-52`. This is cross-client parity/order defect even if web queue-panel policy stays.

### 4. NOT root cause — request completion waits for turn

Web uses REST `steerSession`, not relay RPC: `apps/web/src/App.tsx:294-321`; API call at `packages/core/src/api.ts:375-405`. Mobile uses relay RPC and awaits server response: `apps/mobile/src/lib/use-session-transcript.ts:193-199`; server responds after `SessionsService.steer`: `apps/server/src/sessions/api/sessions.ws.ts:310-320`.

This keeps `steering/sending` active through a non-running provider turn, but committed live events still stream independently. Consider separately for responsiveness; changing API acknowledgement semantics is larger than needed for order fix.

## Existing coverage and gaps

Covered:

- base provider emits persisted `seq`, RUNNING and `user_message`: `apps/server/test/unit/agents/base-agent.provider.spec.ts:153-174`.
- RUNNING routing vs queue/fallback: `apps/server/test/unit/sessions/sessions.steer-running.spec.ts:96-158`.
- Pi durable reservation before SDK and recovery-only reservation: `apps/server/test/unit/agents/pi-agent.provider.spec.ts:717-782`.
- queued fold/drop-on-delivery: `packages/core/src/transcript-build-blocks.spec.ts:37-70`; web focused spec `apps/web/src/lib/transcript-build-blocks.steer.spec.ts:13-35`.
- web intentionally panel-only queue: `apps/web/src/components/session-detail.spec.tsx:1093-1106`.
- web/mobile replay/merge cursors are covered, including late REST + live merge (`apps/web/src/lib/use-session-stream.spec.tsx:460-561`) and mobile highest-live-seq reopen (`apps/mobile/src/lib/use-session-transcript.spec.ts:152-173`).

Missing:

- no core parser case for `steer_reserved`.
- no reservation -> accepted/queued reconciliation case.
- no assertion that user intent is visible before live `steerMidRun()` settles.
- no mobile queued-state label/order test.
- no web/mobile end-to-end sequence proving bubble visibility while first turn remains RUNNING.

## Proposed red regression specs

1. `packages/core/src/transcript-build-blocks.spec.ts`
   - `shows steer_reserved immediately after the flushed partial assistant turn`.
   - input: `user_message, assistant_delta, steer_reserved`; assert `user, assistant(partial), user(pending)`.
   - append `steer_message`; assert one matching user bubble, same chronological slot/stable key, pending cleared.
   - append `steer_queued` instead; assert one matching bubble, queued state, no duplicate.

2. `apps/server/test/unit/sessions/sessions.steer-running.spec.ts`
   - capable provider returns an unresolved promise after emitting reservation; subscribe before steer; assert text-bearing reservation received before promise resolves and no queue event.
   - fallback after reservation: assert exactly one durable intent projection path (`steer_reserved -> steer_queued`), then delivery yields one accepted user turn.

3. `apps/web/src/components/session-transcript.spec.tsx`
   - while `streaming=true`, `steer_reserved` is visible inline immediately; later `steer_message` does not duplicate/move it.
   - keep current queue-panel test unchanged unless user explicitly changes queued UX.

4. `apps/mobile/src/components/transcript-block-view.spec.tsx` or session screen spec
   - pending/reserved and queued user states are distinguishable.
   - queued message order stays stable relative to active assistant turn; delivery does not jump/duplicate.

5. highest reachable flow
   - Mock/provider stub holding turn open: create -> wait first delta -> steer -> assert user bubble before releasing turn -> release -> assert one bubble and correct final order. Run for web real-browser; mobile hook/component equivalent at minimum.

## Recommended scope

First fix shared reservation folding + web/mobile presentation; this directly fixes live steer and preserves provider-neutral architecture. Treat web queued-inline change as separate user decision. Include mobile queued order/affordance if queued behavior is in scope. Do not change repository, WS, bootstrap merge, or runtime-environment injection.

## Unresolved questions

1. Should queued steers remain panel-only on web, or must every submitted message appear inline immediately?
2. For `steer_reserved`, preferred label: no label (optimistic user bubble), “Sending…”, or “Queued…” until accepted/fallback?

**Status:** DONE
**Summary:** Traced create/steer through latest `origin/dev`; transport is monotonic. Confirmed ignored `steer_reserved` as live-steer root, plus separate intentional web queue hiding and mobile queued order/parity defect.
**Concerns/Blockers:** Queue-inline behavior is an explicit existing UX contract; changing it needs user decision.
