# Phase 0 — Spike: validate SDK behavior the typings can't prove

**Effort:** 0.5–1d
**Gate:** finalizes the capabilities matrix in plan.md. No provider code merges before this lands as `spike-findings.md`.

## Setup

- Scratch script (NOT in `apps/server`): `plans/260706-claude-provider/spike/` or a scratchpad dir, `bun add @anthropic-ai/claude-agent-sdk@<pinned>` in an isolated package.
- Run against a throwaway workspace dir (e.g. a tmp git repo) so `~/.claude/projects/<encoded-cwd>` entries are disposable.
- Auth: rely on the machine's existing Max login (no env vars) — this simultaneously validates the subscription-ride assumption.

## Questions to answer (each gets a numbered finding in spike-findings.md)

### S1 — Streaming input mode + deltas
Start `query()` with an async-iterable prompt and `includePartialMessages: true`. Confirm:
- `system/init` arrives first with `session_id`, and `initializationResult()` returns `models` + account info (capture the shape for `listModels()`).
- `stream_event` deltas arrive per assistant message; note the exact delta payload path (`event.delta.type === 'text_delta'` etc.) and whether message-id changes between content blocks (glued-text risk, Codex lesson).
- The `result` message's `result` text matches the concatenation semantics we need for `assistant_message` (conformance suite requires authoritative-final == emitted final).

### S2 — Mid-run steer (`steerWhileRunning` gate)
While a long tool-heavy turn is running (e.g. "count files in this repo one directory at a time"), push a second user message into the input iterable:
- With `priority: 'now'` — does it interject mid-turn (visible in the next assistant message) or queue until turn end?
- With no priority / `'next'` — confirm queueing behavior.
- With `shouldQuery: false` — confirm transcript-append-without-turn behavior.
**Outcome:** `steerWhileRunning: true` only if `'now'` demonstrably alters the in-flight turn; otherwise declare `false` and steer lands as next-turn (still fine — Pi-style).

### S3 — Interrupt
Call `query.interrupt()` mid-turn. Confirm: stream ends cleanly, a result/interrupt-shaped message arrives (note its exact type/subtype), process survives, and a follow-up message on the same query works. Decide what nuncio emits (`interrupted` event) from which SDK signal.

### S4 — Resume across process restart
Turn 1 in process A → kill process → new `query({ resume: sessionId, cwd: same })` in process B asking "what did I ask before?". Confirm context is intact. Also test: wrong `cwd` → capture the exact error (drives the "cannot resume" UX). Optionally test `forkSession: true`.

### S5 — Images
Send an `SDKUserMessage` whose `message.content` includes a base64 image block ("what's in this image?"). Confirm the model sees it. This validates `capabilities.images: true` against the existing MediaStore/attachments pipeline shape (base64 in, per `context.attachments`).

### S6 — Effort switching
Check `Options`/`Query` for an effort control (CLI has `--effort low…max`): is there an SDK option or `applyFlagSettings({ effort })` path? Verify a value actually changes behavior (visible in init/status messages). **Outcome:** `effortSwitch: 'in-session' | 'restart' | 'none'`.

### S7 — Auth probe via bundled binary
Locate the bundled CLI inside `node_modules` (platform optionalDependency) and run `<binary> auth status`. Confirm it returns the same JSON as the system CLI (keychain shared) — this decides whether `claude-cli-resolver` needs a system install at all.

### S8 — canUseTool round-trip
Run with `permissionMode: 'default'` and a `canUseTool` that logs and delays 5s before allowing a Bash call. Confirm: the tool blocks until the callback resolves, `suggestions`/`title`/`displayName` are populated as typings promise, and denying produces a clean tool error (not a crashed turn).

### S9 — Subprocess hygiene
Confirm what `dispose`-shaped teardown looks like: does letting the `Query` be GC'd/return leak the CLI subprocess? What explicit close is needed (return from generator, `interrupt()` + break, AbortSignal via `options`)? Count `claude` processes before/after.

### S10 — settingSources blast radius
Run one query with default `settingSources` and one with `settingSources: []` in a repo containing a CLAUDE.md with a distinctive marker instruction. Confirm which run obeys the marker → pins the v1 default and documents the founder toggle.

## Deliverable

`spike-findings.md` in this directory: one numbered finding per question, exact message shapes captured (redact org ids), and the **final capabilities matrix** pasted back into plan.md. Update the plan's TBD rows.
