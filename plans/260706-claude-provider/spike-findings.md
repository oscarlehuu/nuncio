# Phase 0 spike findings — Claude Agent SDK 0.3.201 (live-run validated)

**Date:** 2026-07-06 · **Machine:** darwin-arm64, Max subscription (keychain), **no `ANTHROPIC_API_KEY` set** on any run.
**Model for all runs:** `claude-haiku-4-5-20251001` (alias `haiku`). **Workspaces:** throwaway git repos under `/tmp/nuncio-claude-spike/` (never the nuncio repo).
**Scripts:** `spike/s1..s10-*.ts` (runnable `bun run <file>`), shared helpers in `spike/spike-common.ts`. Org id / email redacted (`<org-uuid>`, `<email>`).

Every finding below is from an actually-executed run — no mocks, no typings-only claims (typings are cited only to *settle* a shape the run confirmed).

## Final capabilities matrix (finalized by this spike)

| Capability | Value | Basis |
|-----------|-------|-------|
| `interrupt` | `true` | S3: `query.interrupt()` → `result subtype:error_during_execution`, `terminal_reason:'aborted_tools'`; process survived, same query took a follow-up |
| `modelSwitch` | `'in-session'` | `query.setModel()` (typings 2236+); model catalog live from `initializationResult()` (S1) |
| `effortSwitch` | **`'in-session'`** | S6: `Options.effort` accepted at query time AND `query.applyFlagSettings({ effortLevel })` mid-session with no throw, session continued |
| `images` | **`true`** | S5: base64 PNG image block → model answered "Red." for a 2×2 red PNG |
| `steerWhileRunning` | **`true`** | S2: `priority:'now'` demonstrably truncated the in-flight turn (2/5 tool calls) and redirected |

---

## S1 — Streaming input mode + deltas ✅

**Verdict:** `system/init` arrives first with `session_id`; `initializationResult()` returns the model catalog + account; text arrives as `stream_event` → `content_block_delta` → `delta.type:'text_delta'`; **concatenated text deltas === `result.result` exactly** (conformance-safe).

**Evidence:**
- Order: `system/init` (session_id `3efa12a8-…`, model `claude-haiku-4-5-20251001`, permissionMode `default`) → stream events → `result subtype:success`.
- Delta path (first events): `message_start`, `content_block_start`, then **`thinking_delta`** events, then `text_delta`. So thinking and text both arrive as `content_block_delta` — discriminate on `event.delta.type`.
  ```
  event.type=content_block_delta delta.type=thinking_delta   // interleaved BEFORE text
  event.type=content_block_delta delta.type=text_delta
  ```
- **Glued-text check:** a single assistant turn had one message id (`msg_01BJuLBkb3Tx3SL8Wzr3gHUn`). `SDKPartialAssistantMessage` carries `uuid` + `session_id` (sdk.d.ts:3884-3891) — use the message/uuid boundary to insert separation when it changes (Codex lesson still applies across multiple assistant messages in a multi-turn run).
- **Concatenation:** `deltaText.trim() === result.result.trim()` → **true**.

**`initializationResult()` shape** (`SDKControlInitializeResponse`, sdk.d.ts:3313) — `models: ModelInfo[]`, `account`:
```jsonc
// models[] — feed listModels() directly:
{ "value":"default",  "resolvedModel":"claude-opus-4-8[1m]", "displayName":"Default (recommended)", "supportsEffort":true, "supportedEffortLevels":["low","medium","high","xhigh","max"], "supportsAdaptiveThinking":true, "supportsFastMode":true, "supportsAutoMode":true }
{ "value":"opus[1m]", "resolvedModel":"claude-opus-4-8[1m]", "displayName":"Opus", "supportsEffort":true, ... }
{ "value":"claude-fable-5[1m]", "resolvedModel":"claude-fable-5", "displayName":"Fable", "supportsEffort":true, ... }
{ "value":"sonnet", "resolvedModel":"claude-sonnet-5", "displayName":"Sonnet", "supportsEffort":true, ... }
{ "value":"haiku", "resolvedModel":"claude-haiku-4-5-20251001", "displayName":"Haiku" }   // NOTE: no supportsEffort
// account:
{ "email":"<email>", "organization":"<email>'s Organization", "subscriptionType":"Claude Max", "apiProvider":"firstParty" }
```

**Provider consequence (Phase 1):** map `stream_event`/`text_delta` → `assistant_delta`; `thinking_delta` → `thinking_start`/`thinking_delta` (thinkingId = message id + block index); emit authoritative `assistant_message` from `result.result` (matches concatenation → conformance passes). `listModels()` = `initializationResult().models` mapped `{ value → id, displayName → label }`; the `value` string (e.g. `sonnet`, `opus[1m]`) is what `setModel()`/`options.model` take.

---

## S2 — Mid-run steer → **`steerWhileRunning: true`** ✅

**Verdict:** `priority:'now'` **alters the in-flight turn** — it does not wait for turn end. The three `SDKUserMessage` steer modes behave distinctly and match the typings (sdk.d.ts:4298 `priority`, 4305 `shouldQuery`).

**Evidence** (long task = five sequential `sleep 2` Bash calls; steer injected right after the 2nd tool_use):

| Mode | In-flight turn behavior | Result | Interpretation |
|------|------------------------|--------|----------------|
| `priority:'now'` | Turn 1 **cut short at 2/5 tool calls**, empty result; then a **new turn** (num_turns=1) replied `PURPLE` | 2 results | Redirects the running turn immediately; the redirect surfaces as a *separate* assistant turn, not text spliced into the current message |
| `priority:'next'` | Turn ran **all 5 sleeps to completion**; `PURPLE` appeared **inside that turn's final result** (num_turns=6, marker in first turn) | 1 result | Queued; merged into the current turn's context rather than spawning a fresh turn |
| `shouldQuery:false` | Turn ran to completion normally; **no extra turn spawned**; model did not act on the note (pure transcript append) | 1 result | Append-only, per typings ("merged into the next user message that does query") |

**Provider consequence:** nuncio steer-while-running = push an `SDKUserMessage` with **`priority:'now'`** into the session's open input iterable. Expect the in-flight turn to end early and a fresh assistant turn to carry the steered response — so the provider must tolerate the current turn producing a short/empty `result` immediately followed by a new turn (don't treat the early terminal as the session ending). For "queue for after this turn" semantics use `'next'`; for silent context injection use `shouldQuery:false`. This is strictly better than Pi-style next-turn-only.

---

## S3 — Interrupt ✅

**Verdict:** `query.interrupt()` ends the turn cleanly, the process survives, and the **same query accepts a follow-up**. The interrupt signal to key on is `result.terminal_reason === 'aborted_tools'` (+ `subtype:'error_during_execution'`, `stop_reason:'tool_use'`).

**Evidence:**
```
[S3] >>> handle.interrupt()  → interrupt() resolved
[S3] result #1 subtype=error_during_execution stop_reason="tool_use" terminal_reason="aborted_tools" num_turns=3
[S3]   text: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]
[S3] >>> follow-up on SAME query
[S3] result #2 subtype=success stop_reason="end_turn" terminal_reason="completed" → "YES"
```
`TerminalReason` union includes `'aborted_tools'` / `'aborted_streaming'` (sdk.d.ts:6553).

**Provider consequence:** nuncio `interrupt()` → `query.interrupt()`. Emit an `interrupted` event when a `result` arrives with `terminal_reason` in `{aborted_tools, aborted_streaming}` **rather than** landing ERROR — the `error_during_execution` subtype here is an interrupt, not a failure. Do NOT close the session on interrupt; the query stays usable for the next prompt.

---

## S4 — Resume across process restart ✅

**Verdict:** `resume: <session_id>` + **same `cwd`** in a *separate OS process* retains full context. Wrong `cwd` → a **result error** (not a thrown exception) with exact text `No conversation found with session ID: <id>`.

**Evidence** (two independent `bun run` invocations):
```
[turn1  procA] session_id=52505585-… reply="OK." (asked to remember BANANA-BOAT-42)
[turn2  procB] resume=52505585-… cwd=ws1 → "BANANA-BOAT-42"   context retained? YES
[wrongcwd procC] resume=52505585-… cwd=ws3 → subtype=error_during_execution
                 errors=["No conversation found with session ID: 52505585-…"]   retained? NO
```

**Provider consequence:** `canResumeThread` = `providerThreadId` set (pattern `pi-agent.provider.ts:132`). On resume ALWAYS pass `cwd: session.workspace` (immutable on the row). The "cannot resume" case surfaces as a **`result` with `subtype:'error_during_execution'` whose `errors[]` contains "No conversation found with session ID"** — the provider must inspect the result message, **not** rely on `query()` throwing. Map it to a clean "cannot resume (workspace moved or session evicted)" error event.

---

## S5 — Images → **`images: true`** ✅

**Verdict:** a base64 image block in `SDKUserMessage.message.content` is seen by the model.

**Evidence:** script hand-builds a 2×2 solid-red PNG (self-contained, `deflateSync` + manual PNG chunks), sends
`{ type:'image', source:{ type:'base64', media_type:'image/png', data:<b64> } }` + a text block asking the color →
`result subtype:success`, answer **`"Red."`**.

**Provider consequence:** `capabilities.images: true`. Consume `context.attachments` (MediaStore base64) → prepend image content blocks to the user `MessageParam` (role:'user', content: `[{type:'image', source:{type:'base64', media_type, data}}, {type:'text', text}]`). Content is an array of blocks, matching the existing attachments pipeline.

---

## S6 — Effort → **`effortSwitch: 'in-session'`** ✅

**Verdict:** effort is a **first-class SDK option** (`Options.effort: EffortLevel`, sdk.d.ts:1620), not merely a CLI flag, AND it is changeable mid-session via `query.applyFlagSettings({ effortLevel })` (sdk.d.ts:2312; `Settings.effortLevel`, sdk.d.ts:5990) — no restart required.

**Evidence:**
```
[S6] query started with effort:'low'  → turn-1 result "ONE"  (accepted, no error)
[S6] applyFlagSettings({ effortLevel:'high' }) — OK, no throw (in-session change)
[S6] turn-2 result "TWO"  (session continued)
[S6] models supportsEffort: default:true, opus[1m]:true, claude-fable-5[1m]:true, sonnet:true, haiku:undefined
```

**Caveat (important):** **Haiku reports `supportsEffort: undefined`** — effort applies to Opus/Fable/Sonnet, not Haiku. `applyFlagSettings` did not throw on Haiku (silently no-op) but the provider should **gate the effort control on `model.supportsEffort`** from the catalog so the UI doesn't offer effort for models that ignore it.
Note: `applyFlagSettings` is streaming-input-mode only (sdk.d.ts:2307) — fine, that's our mode. `effortLevel` in `Settings` is typed `'low'|'medium'|'high'|'xhigh'` (no `'max'`), while `Options.effort`/`EffortLevel` includes `'max'` (sdk.d.ts:522, 5990) — for the mid-session path, clamp `'max'` or set effort at query time instead.

**Provider consequence:** support effort both at query start (`options.effort`) and mid-session (`applyFlagSettings({ effortLevel })`), same UX class as Codex. Drive the effort picker from `ModelInfo.supportsEffort` / `supportedEffortLevels`.

---

## S7 — Auth via bundled binary ✅

**Verdict:** the SDK-bundled platform binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) returns **identical** auth JSON to the system `claude`, riding the shared keychain — **no `ANTHROPIC_API_KEY`, no system CLI install required**.

**Evidence** (`ANTHROPIC_API_KEY` unset):
```
bundled: node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
BUNDLED auth status (exit 0): { loggedIn:true, authMethod:"claude.ai", apiProvider:"firstParty", email:"<email>", orgId:"<org-uuid>", subscriptionType:"max" }
SYSTEM  auth status (exit 0): { …identical… }
```

**Provider consequence:** `claude-cli-resolver` resolves the availability/auth probe against the **bundled** binary — `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>/package.json')` → sibling `claude` file — with a `NUNCIO_CLAUDE_BIN` override. `isAvailable` = `auth status` JSON `loggedIn:true`. No dependency on a system Claude Code install. (Auth-status output is stable JSON; parse it, never the session JSONL.)

---

## S8 — `canUseTool` round-trip ✅

**Verdict:** the callback **blocks the tool until it resolves** (no deadline), payload fields are populated, allow proceeds, and **deny yields a clean tool error with the turn still succeeding**.

**Evidence** (permissionMode `default`; two Writes to paths outside cwd → both gated; callback delays 4s, allows #1, denies #2):
```
call #1 tool=Write  displayName="Write"  description="/tmp/…/s8-allow.txt"
        decisionReason="Path is outside allowed working directories"
        suggestions=[{type:'setMode',mode:'acceptEdits',destination:'session'},
                     {type:'addDirectories',directories:['/tmp/…','/private/tmp/…'],destination:'session'}]
        toolUseID=toolu_01NK…  requestId=1c9d…  signal.aborted=false
        callback resolving after 4002ms          → ALLOW  → file created
call #2 tool=Write  …same fields…  resolving after 4001ms → DENY("spike: denied…")
        tool_result is_error:true  content="spike: denied by nuncio approval policy"
result subtype:success  permission_denials:[{tool_name:'Write', tool_use_id:'toolu_01JA…', tool_input:{…}}]
final text: "**Second write failed**: … was denied by nuncio approval policy and was not created."
```
Filesystem check: `s8-allow.txt` created, `s8-deny.txt` absent. `title` was **`undefined`** for Write (the bridge did not render a full sentence); `displayName` + `description` (the path) + `decisionReason` were present.

**Two gotchas discovered (Phase 1 must honor):**
1. **`allowedTools` bare entries SHADOW `canUseTool`.** Listing `"Bash"` (or any tool) in `allowedTools` auto-approves it *before* the callback — SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Phase 1 must NOT bare-list tools it wants nuncio to gate. Use `canUseTool` (+ permission rules) for gating.
2. **Safe Bash is auto-approved.** `echo`-class commands are classified safe and **bypass `canUseTool` even in `default` mode** — only genuinely-privileged ops (Write outside cwd, etc.) reach the callback. Don't expect a prompt for every tool.

**Provider consequence:** route `canUseTool` → nuncio's existing interaction/approval flow (pending-state UX). Prompt text = `title ?? \`${displayName}: ${description}\`` (title is not always present). Return `{behavior:'allow', updatedInput}` or `{behavior:'deny', message}`. `dispose()`/AbortSignal aborts a parked callback (the `options.signal`). Persist `suggestions` for an "always allow" affordance (`updatedPermissions`). Default permission mode = `acceptEdits` (founder decision) + `canUseTool` for the rest.

---

## S9 — Subprocess hygiene ✅

**Verdict:** completing a turn / closing the input queue does **NOT** reap the CLI subprocess (it stays warm). Reliable teardown = **`interrupt()`+break** OR **`abortController.abort()`** — both drop the child to zero. `abort()` is the clean `dispose()` primitive: it makes the async generator throw and calls `child.kill()` (sdk.d.ts:6376).

**Evidence** (counting `claude-agent-sdk` processes; parent bun pid 4165):
```
(a) normal completion : before 0 → during 1 → after+3s 1   ← subprocess still alive after result
(b) break w/o interrupt: during 2 → after+3s 1              ← its own child reaped by breaking consumer
(c) interrupt()+break  : during 2 → after+3s 0              ← full teardown
FINAL: 0 leaked
--- focused abortController test ---
mid-turn count 1 → ac.abort() → generator threw (AbortError) → after+3s: 0
```

**Provider consequence:** hold **one `AbortController` per session** (`options.abortController`). `dispose()` MUST call `abortController.abort()` (kills the CLI child) — do not rely on GC or on merely stopping consumption; a completed turn leaves the process resident. This matches the plan's "dispose() interrupts + closes (kills the CLI subprocess)". Also consider IDLE-timeout disposal since one resident CLI per active session is the memory cost (same class as Codex app-server).

---

## S10 — `settingSources` blast radius ✅

**Verdict:** `settingSources: []` fully isolates the session — a repo `CLAUDE.md` marker is **ignored**. `settingSources: ['project']` loads it. This pins the v1 default (empty) and the documented founder toggle.

**Evidence** (ws2 CLAUDE.md: "Always end every reply with the word PINEAPPLE"):
```
settingSources=[]          → obeyed marker? no   reply: "Hello! I'm Claude…"           (no PINEAPPLE)
settingSources=["project"] → obeyed marker? YES  reply: "Hello! … PINEAPPLE"
```
Typing confirms: `[]` = SDK isolation mode; must include `'project'` to load CLAUDE.md files (sdk.d.ts:1862-1864).

**Provider consequence:** v1 default `settingSources: []` (session behavior fully determined by nuncio; reproducible; no `~/.claude` plugins/hooks/CLAUDE.md leakage). Expose a documented toggle to add `'project'`/`'user'` later (founder-flip). **Note:** even with `[]`, the machine's custom tool set (Cron, DesignSync, EnterWorktree, …) still appeared in `system/init.tools` — that's the CLI's own tool registry, independent of `settingSources`; harmless for the provider but worth knowing the tool list is environment-shaped.

---

## Contradictions with the plan's assumptions

None that block. Refinements the plan should absorb (all captured in the matrix + consequences above):
1. **`effortSwitch` is `'in-session'`** (was "TBD, likely") — and effort is model-gated (Haiku: no effort).
2. **`steerWhileRunning: true`** confirmed via `priority:'now'`, but the redirect surfaces as a *new* assistant turn (the current turn ends early) — the provider must not treat that early terminal as session-end.
3. **Resume failure and interrupt both arrive as `result subtype:'error_during_execution'`**, NOT as thrown exceptions — discriminate by `terminal_reason` (`aborted_tools` = interrupt) and by `errors[]` text ("No conversation found…" = cannot-resume). Do not blanket-map `error_during_execution` → ERROR.
4. **`canUseTool` pitfalls:** bare `allowedTools` entries shadow the callback; safe Bash bypasses it; `title` isn't always populated (fall back to `displayName`+`description`).
5. **dispose() must `abortController.abort()`** — completing a turn leaves the subprocess resident.
