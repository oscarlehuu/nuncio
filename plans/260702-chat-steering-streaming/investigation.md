# Chat steering & streaming — investigation

**Worktree:** `charming-pike-6ab513` · **Date:** 2026-07-02
**Goal:** make the app usable for real daily work — smooth streaming and real steering for sessions created from the app *and* imported from the Pi CLI.
**Method:** 4 parallel code-mapping passes (server pipeline, steering path, pi provider/import, web rendering), then hand-verification of every load-bearing claim against source. Claims marked ✅ were re-read directly; the rest come from the mapping passes with quoted code.

---

## 1. Architecture snapshot

```
Pi SDK session.subscribe()                    web
  text_delta ──► pi-agent.provider maps to     ▲
  assistant_delta ──► BaseAgentProvider        │ EventSource (SSE)
  .pushEvent ──► EventsRepository.append       │ /api/sessions/:id/stream?since=seq
  (SQLite INSERT per event) ──► emit ──►       │
  SessionsService bus (EventEmitter/session) ──┘
                                               └► useSessionStream → useTranscriptBlocks
                                                  → Transcript → AssistantBubble
                                                  → useThrottledStreamText → ReactMarkdown
```

- Transport is SSE per session (`sessions.controller.ts:147-178`), catch-up by `since` seq, 15s heartbeat, client reconnect after 2s (`use-session-stream.ts:6`).
- App-created and CLI-imported pi sessions **share one resume path**: `providerThreadId` → `SessionManager.open(...)` → `createAgentSession(...)` (`pi-agent.provider.ts:224-245`). Once resumed, streaming/interrupt/model-switch are identical. ✅
- Imported transcripts are hydrated block-level (`pi-transcript-hydrate.ts:19-78`); thinking blocks are dropped at import (`:38`).

## 2. Findings — streaming smoothness (ranked)

### S1 — Fixed 40 chars/sec reveal throttle (CRITICAL, web) ✅
`use-throttled-stream-text.ts:4,27-28` reveals streamed text at 40 chars/s (2 chars per 50ms tick), regardless of how fast tokens actually arrive (typically 5–10× faster). Consequences:
- text crawls far behind the real stream, then **snaps to full length** when the run ends (`:22-24,41`);
- opening a session mid-stream starts `revealedLen` at **0** (`:15-17`) — a 4,000-char in-flight message replays for ~100 seconds.
This alone explains most of the "not smooth" feel.

### S2 — O(n²) server hot path: full event list re-read per delta (CRITICAL, server) ✅
`sessions.service.ts:700-705` (`onAgentEvent`): on **every** emitted delta the service calls `this.events.list(id)` — loading and JSON-parsing the *entire* event log from SQLite — just to recover the seq of the row that `pushEvent` appended one frame earlier (`agents.base-provider.ts:57-65` discards the appended row and re-emits only `{type,payload}`). A 2,000-event session pays ~2,000 row parses per token.

### S3 — Per-token persistence write amplification (HIGH, server)
Every `assistant_delta` costs `SELECT MAX(seq)` + `INSERT` (`events.repository.ts:27-47`) plus a `touchPreview` `UPDATE sessions` (`sessions.repository.ts:229-234`). Besides write cost, the log accumulates thousands of 1-token rows, which directly inflates S2 and initial catch-up time.

### S4 — Full markdown re-parse per 50ms tick (HIGH, web)
`AssistantBubble` → `MarkdownView` re-runs `ReactMarkdown` (+ remark-gfm) over the **whole growing message** on every throttle tick (`transcript-bubbles.tsx:7-17`, `markdown-view.tsx`). Mermaid/code blocks re-render mid-stream. Cost grows with message length exactly when smoothness matters most.

### S5 — Scroll effect fires per event with read/write layout thrash (HIGH, web)
`session-detail.tsx:185-195` depends on `events.length`, so every delta reads `scrollHeight/scrollTop/clientHeight` and writes `scrollTop` synchronously; `session-tile.tsx:89-93` does the same per tail change. No rAF coalescing.

### S6 — Index-based keys + unmemoized item renderer (MEDIUM, web)
`session-transcript.tsx:200` keys items as `item-${i}`; when a tool group splits or a block is inserted, keys shift and React remounts siblings (collapse state flashes/loses). `RenderItemView` (`:101-174`) is not memoized, so every delta re-renders every block in the transcript.

### S7 — Grid: one EventSource per tile hits the browser connection limit (HIGH, web)
Each tile opens its own SSE (`session-tile.tsx:81`, `grid-view.tsx:276-284`). Dev server (Vite) and typical self-hosted deploys are HTTP/1.1 → **~6 concurrent connections per origin**; a 3×3 grid (9 streams + API fetches) stalls the extras silently. Also N× parse/render cost while several sessions stream.

### S8 — Sessions actively running in the Pi CLI stream block-level only (MEDIUM, by design today)
When a session is being driven by the CLI while viewed in the app, updates arrive via a file watcher with 150ms debounce → whole-message refresh events, no token deltas (`sessions.service.ts:543-590,472-490`). Smoothness here is bounded by transcript-file flush cadence, not by SSE.

### S9 — No transcript virtualization (MEDIUM, web)
All blocks stay mounted (`session-transcript.tsx:197-214`); long working sessions accumulate DOM and style cost.

## 3. Findings — steering

### T1 — Mid-run steering exists in the Pi SDK, is wired in the provider, and is blocked one layer up (CRITICAL) ✅
- SDK: `session.steer(text)` — "Queue a steering message while the agent is running. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call"; plus `followUp()`, `pendingMessages`, `getPendingMessages()` (`agent-session.d.ts:323-404`). Same mechanism the pi CLI itself uses.
- Provider: `executePrompt` already passes `streamingBehavior: 'steer'` when `isSteer` (`pi-agent.provider.ts:174`).
- Gate: `SessionsService.steer` rejects with 400 whenever status is RUNNING (`sessions.service.ts:250-252`; FSM has no RUNNING→RUNNING, `sessions.fsm.ts:4-11`).
**Net effect: you can never steer a running pi agent from the app — the single biggest usability gap, and the fix is unblocked server-side.**

### T2 — No queueing; grid tile can silently lose the message (HIGH) ✅(UI quotes)
Send-while-RUNNING → immediate 400. Session-detail disables input while RUNNING (`session-detail.tsx:152-157`) so you *wait*; the grid tile input is only disabled during the in-flight request (`session-tile.tsx:186-213`, `disabled={steering}`), so sending to a running session errors — and unlike session-detail (`:204` restores text) the tile does not restore the lost message.

### T3 — "Stop" is pause/dispose, not interrupt; interrupt is only implemented for pi and unused by the UI (MEDIUM)
UI stop button calls `pause()` → `dispose()` (`session-detail.tsx:465-475`, `sessions.service.ts:326-337`). `POST /:id/interrupt` works only for pi (`pi-agent.provider.ts:123-137`, `session.abort()`); Cursor SDK has no abort at all, Codex's `turn/interrupt` is only fired inside `dispose`. No "interrupted" event is emitted for UI feedback.

### T4 — Pi sessions can't answer interactive AskQuestion-style requests (MEDIUM)
`supportsInteraction()` is implemented only by Cursor CLI (`cursor-cli.provider.ts:69-71`); pi has neither it nor `submitInteraction`, so `respondInteraction` returns 501 (`sessions.service.ts:307-312`). A pi run that asks a question can't be answered from the app.

### T5 — No IME composition guard on Enter (MEDIUM — Vietnamese input) ✅(quotes)
All chat inputs submit on bare `Enter && !shiftKey` without checking `isComposing`/`keyCode 229` (`session-detail.tsx:428-434`, `session-tile.tsx:191-195`, `grid-slot-composer.tsx`). Risk of premature submit/lost diacritics with VN IME.

### T6 — Steer error paths & feedback
`handleSteer` re-throws after restoring text; no optimistic user bubble — the message only appears after the server round-trip persists `steer_message`, so sends feel laggy on slow links.

## 4. Pi CLI-imported sessions — differences that matter

| Aspect | App-created | CLI-imported |
|---|---|---|
| Resume / steer / interrupt | in-process SDK | **same code path** (`providerThreadId` → `SessionManager.open`) ✅ |
| Live deltas after resume | token-level | token-level (identical) |
| Historical transcript | full event log incl. thinking | block-level; **thinking dropped** (`pi-transcript-hydrate.ts:38`) |
| While CLI is still driving the session | n/a | file-watcher refresh, 150ms debounce, whole blocks (S8) |

## 5. Proposed plan (phased)

### Phase 1 — perceived smoothness, no protocol changes (web + 1 server fix)
1. **Adaptive reveal** replacing fixed 40cps: reveal speed proportional to backlog (e.g. drain backlog within ~400ms, floor at ~60cps, instant flush ≥ threshold), and start `revealedLen` at `fullText.length` minus a small window when mounting mid-stream. Kills the crawl-then-snap (S1).
2. **Server: emit the appended event** — pass the full `SessionEvent` returned by `events.append` through `pushEvent`/`onAgentEvent` instead of re-reading the whole log (S2). Small, safe, huge on long sessions.
3. **Memoize** `RenderItemView` + stable block keys derived from block start seq (S6).
4. **rAF-coalesced stick-to-bottom** with a shared hook for detail + tiles (S5).
5. **IME guard** (`e.nativeEvent.isComposing`) on all three inputs (T5).
6. Grid tile parity: restore text on failed steer (T2, interim until Phase 2).

### Phase 2 — real steering (the "can I work in this app" phase)
1. Add provider capability `steerWhileRunning` (pi: true). In `SessionsService.steer`, when RUNNING and capable: skip the FSM transition, emit `steer_message`, and call a provider mid-run path that invokes `session.steer(text)` on the live handle (no second `runOrSteer` status dance). (T1)
2. UI: keep input enabled while RUNNING for capable sessions; render queued steer messages distinctly (SDK exposes pending messages) until delivered.
3. Split **Stop** into: Interrupt (pi `abort()`, land IDLE, keep partial output — wire the existing endpoint into the UI) vs Pause (today's dispose). Emit an explicit event on interrupt for feedback. (T3)
4. Optional: server-side queue-on-IDLE for non-capable providers (Cursor SDK/CLI, Codex) so no send is ever rejected.

### Phase 3 — scale & polish
1. **Coalesce persisted deltas** (flush ~100–250ms or N chars per row) while still emitting live deltas immediately — shrinks the event log, S2/S3 and catch-up cost. Needs care with seq-based `since` catch-up.
2. **Single multiplexed stream** for the grid (one SSE/WS carrying multiple sessions) to escape the 6-connection limit (S7).
3. **Streaming markdown**: split completed markdown into memoized stable blocks, re-parse only the streaming tail; defer mermaid render until its code fence closes (S4).
4. Transcript virtualization (S9); optionally synthesize deltas for CLI-driven sessions by diffing watcher refreshes (S8).
5. Pi interactive tools (`supportsInteraction`/`submitInteraction`) if pi runs ever ask questions in practice (T4).

### Verification
Each phase gets verified in a real browser (system Chrome via playwright-core, per project practice): stream a long markdown-heavy response, steer mid-run, open a mid-stream session, 3×3 grid with ≥7 running sessions, VN IME typing.

## 6. Open questions

1. Phase 2 default for `streamingBehavior`: `steer` (interject before next LLM call) vs `followUp` (wait for turn end)? CLI default feel is `steer`; suggest `steer` with `followUp` as a per-send modifier later.
2. Delta coalescing (Phase 3.1) changes what the event log stores (fewer, bigger rows). OK for transcript fidelity? Live view is unaffected.
