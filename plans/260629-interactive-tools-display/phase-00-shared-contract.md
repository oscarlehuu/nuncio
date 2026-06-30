# Phase 00 — Shared Event Contract + Schema + Hydrator Mapping

**Priority:** P0 (gates all other phases)
**Status:** Not started
**Depends on:** nothing
**Estimated:** 0.5 day
**Lane:** A (backend) + C (tests)
**Commit:** 1 of 4 in the PR

## Context Links

- [Plan overview](./plan.md)
- Event types: `apps/server/src/sessions/domain/events.types.ts`
- Hydrator: `apps/server/src/cursor-local/cursor-transcript-hydrate.ts`
- Parser: `apps/server/src/cursor-local/cursor-transcript.parser.ts`
- Reference (Synara): `packages/contracts/src/providerRuntime.ts` — `UserInputQuestion` schema

## Overview

Add the shared event types and `UserInputQuestion` schema. Wire the handoff hydrator to detect `AskQuestion` / `AskUserQuestion` / `ask_question` tool uses and emit paired `user_input_requested` + `user_input_resolved` events (without answers — verified user answers appear as the next `user_message`, already captured). This phase ships backend-only — Phase 1 renders the new events.

## Key insights

- **Answers are NOT stored or extracted** (locked decision 2026-06-29, verified on 3+ real transcripts). `user_input_resolved` for historical imports carries only `{ requestId, resolvedBy: 'user' }`. The user's actual answer is the next `user_message` in the event log, rendered by the existing `UserBlock` component.
- **`tool_use` has NO `id` field** in Cursor JSONL (verified). `requestId` is a UUID generated at hydrate time. This is fine for historical display — we don't need to correlate back to JSONL.
- **`input.questions` can be a STRING or ARRAY** (verified). `normalizeUserInput` must `JSON.parse` if it receives a string, then validate the resulting array.
- **Hydrator emits paired requested + resolved at import time.** The pairing tells `derivePendingUserInput` (Phase 2) that this question is closed, so it doesn't show as a live pending banner.
- **No DB migration.** The `events` table is schemaless on `payload`; new event types just append with the next `seq`.
- **Defensive parsing.** AskQuestion JSONL shape varies. If `questions` is missing or unparseable (even after `JSON.parse`), fall back to the existing `tool_start`+`tool_end` path so import never fails.
- **Tool name registry, not hardcoded branches.** A small `tool-interaction.registry.ts` maps known tool names → interaction kind. Adding a future provider's tool is one entry.

## Requirements

### Functional

- New event types in `SessionEventType`: `user_input_requested`, `user_input_resolved`.
- New payload interfaces:
  - `UserInputRequestedPayload`: `{ requestId: string; questions: UserInputQuestion[]; title?: string }`
  - `UserInputResolvedPayload`: `{ requestId: string; resolvedBy: 'user' | 'timeout' | 'skip' | 'provider' }` — **no `answers` field** (user answer is the next `user_message` in the event log).
- `UserInputQuestion` shape: `{ id, header?, prompt, options: UserInputOption[], allowMultiple? }`.
- `UserInputOption` shape: `{ id, label, description? }` — `description` included per locked decision (real AskQuestion options have it).
- `tool-interaction.registry.ts`: `INTERACTIVE_TOOLS` map with entries `AskQuestion`, `AskUserQuestion`, `ask_question` → kind `'questionnaire'`. `normalizeUserInput(tool, input)` returns `{ questions, title? } | undefined`.
- `normalizeUserInput` handles both array-form and string-form `questions`:
  - If `input.questions` is a string → `JSON.parse` it; if parse fails → return `undefined` (fallback).
  - If `input.questions` is an array → use directly.
  - Validate each question has `id` + `prompt` + `options[]`; each option has `id` + `label` (description optional). Skip invalid questions.
  - If no valid questions → return `undefined` (fallback).
- `turnsToSessionEvents` (hydrator): for each `tool_use` whose name is in `INTERACTIVE_TOOLS`:
  1. Attempt to normalize via `normalizeUserInput(tool.name, tool.input)`.
  2. If successful: emit `user_input_requested { requestId: crypto.randomUUID(), questions, title? }` then `user_input_resolved { requestId, resolvedBy: 'user' }`. Skip the `tool_start`/`tool_end` for this tool.
  3. If normalization fails: fall back to existing `tool_start`+`tool_end`.
- Truncation: `truncatePayload` (4KB) applies to `questions`.

### Non-functional

- Hydration remains one-shot, idempotent (existing behavior preserved).
- No new repo method — `appendBatch` already exists from Phase 04 handoff.
- No new HTTP endpoint in this phase — events surface via existing `GET /api/sessions/:id/events` and SSE stream.

## Architecture

```
turnsToSessionEvents(turns)  # hydrator — emit, no answer extraction
  for each turn:
    if turn.role === 'user':
      emit user_message (unchanged — this IS the answer to a prior AskQuestion)
    else: # assistant
      for each tool in turn.tools:
        kind = INTERACTIVE_TOOLS[tool.name]
        if kind === 'questionnaire':
          normalized = normalizeUserInput(tool.name, tool.input)
          if normalized:
            requestId = crypto.randomUUID()  # tool_use has no id in JSONL
            emit user_input_requested { requestId, questions: normalized.questions, title: normalized.title }
            emit user_input_resolved { requestId, resolvedBy: 'user' }  # NO answers
            continue
      # fallback: existing tool_start + tool_end
      emit tool_start { tool, input }
      emit tool_end { tool }
      if turn.text: emit assistant_message

normalizeUserInput(tool, input)
  questions = input.questions
  if typeof questions === 'string':
    try: questions = JSON.parse(questions)
    catch: return undefined  # malformed, fallback to tool_start/end
  if !Array.isArray(questions) or questions.length === 0: return undefined
  valid = questions.filter(q => q.id && q.prompt && Array.isArray(q.options))
  if valid.length === 0: return undefined
  return { questions: valid.map(normalizeQuestion), title: input.title }
```

## Related code files

**Modify:**
- `apps/server/src/sessions/domain/events.types.ts` — add event types + payload interfaces + type guards (`isUserInputRequestedEvent`, `isUserInputResolvedEvent`)
- `apps/server/src/cursor-local/cursor-transcript-hydrate.ts` — AskQuestion branch (emit requested + resolved, no answers)

**Create:**
- `apps/server/src/sessions/domain/user-input.types.ts` — `UserInputQuestion`, `UserInputOption` (with `description?`), `UserInputAnswer` (future, for live respond) types + `normalizeUserInput()` helper
- `apps/server/src/agents/tool-interaction.registry.ts` — `INTERACTIVE_TOOLS` map + `InteractionKind` type
- `apps/server/test/unit/sessions/user-input.types.spec.ts` — schema parsing tests (array + string form)
- `apps/server/test/unit/agents/tool-interaction.registry.spec.ts` — registry lookups
- Extend `apps/server/test/unit/cursor-local/cursor-transcript-hydrate.spec.ts` — AskQuestion → paired events; fallback when unparseable; string-form questions

**Delete:** none.

## Implementation steps (TDD-first)

1. **Red — `user-input.types.spec.ts`:** write failing tests for `normalizeUserInput`:
   - Cursor `AskQuestion` with `questions: [{ id, prompt, options: [{ id, label, description }], allowMultiple }]` (array form) → returns `{ questions, title? }`
   - `questions` as a JSON string (string form) → `JSON.parse` succeeds → returns `{ questions }`
   - `questions` as a malformed string (invalid JSON) → returns `undefined` (fallback)
   - `questions` missing → returns `undefined`
   - `questions` empty array → returns `undefined`
   - Question missing `id` or `prompt` or `options` → that question skipped; if all invalid → `undefined`
   - Option missing `id` or `label` → skipped; `description` optional (preserved if present)
   - Claude `AskUserQuestion` with same shape → returns `{ questions }`
   - Unknown tool name → returns `undefined`
2. **Green — `user-input.types.ts`:** implement `UserInputQuestion`/`UserInputOption` types + `normalizeUserInput()` with string-form handling + validation.
3. **Red — `tool-interaction.registry.spec.ts`:** registry lookups return `'questionnaire'` for the three known names; `'none'` for `read`/`bash`/etc.
4. **Green — `tool-interaction.registry.ts`:** the map + `InteractionKind` type.
5. **Red — extend `cursor-transcript-hydrate.spec.ts`:**
   - Turn with `tool_use` name `AskQuestion` and array-form `questions` → emits `user_input_requested { requestId: <uuid>, questions, title? }` then `user_input_resolved { requestId, resolvedBy: 'user' }`, **no `answers` field**, **no** `tool_start`/`tool_end`
   - Turn with `tool_use` name `AskQuestion` and string-form `questions` (valid JSON) → same as above
   - Turn with `tool_use` name `AskQuestion` and malformed string `questions` → falls back to `tool_start` + `tool_end` (no crash)
   - Turn with `tool_use` name `AskQuestion` and missing `questions` → falls back to `tool_start` + `tool_end`
   - `requestId` is a non-empty string (UUID)
   - Turn with non-interactive tool (`Read`) → unchanged behavior
   - AskQuestion followed by a user turn → user turn emits `user_message` as usual (this is the "answer" — no special correlation)
6. **Green — extend `cursor-transcript-hydrate.ts`** with the AskQuestion branch (no answer extraction — just emit the two events).
7. **Red+Green — `events.types.ts`:** add the new event types + payload interfaces + type guards. Unit-test the guards.
8. **Refactor** under green: keep hydrator under ~100 lines; the `normalizeUserInput` helper absorbs the parsing complexity.

## Todo List

- [ ] Write `user-input.types.spec.ts` (red) — cover array + string form + validation
- [ ] Implement `user-input.types.ts` (green)
- [ ] Write `tool-interaction.registry.spec.ts` (red)
- [ ] Implement `tool-interaction.registry.ts` (green)
- [ ] Extend `cursor-transcript-hydrate.spec.ts` with AskQuestion cases (red)
- [ ] Implement AskQuestion branch in hydrator — emit requested + resolved without answers (green)
- [ ] Add event types + guards to `events.types.ts` (red→green)
- [ ] Run `bun run test` — all green
- [ ] Run `bun run lint` — green
- [ ] Commit (Phase 0 — `feat: shared user_input event contract + hydrator mapping`)
- [ ] Code review pass

## Success Criteria

- `bun test test/unit/sessions/user-input.types.spec.ts` passes (array + string form + validation)
- `bun test test/unit/agents/tool-interaction.registry.spec.ts` passes
- `bun test test/unit/cursor-local/cursor-transcript-hydrate.spec.ts` passes (existing + new cases)
- `bun run test` (full unit suite) stays green
- `bun run lint` stays green
- Importing a handoff transcript with an AskQuestion produces `user_input_requested`/`user_input_resolved` rows in the event log **without** `answers` in the resolved payload
- No existing hydrator test breaks (back-compat for non-AskQuestion tools)
- String-form `questions` handled (JSON.parse); malformed → fallback to `tool_start`/`tool_end`

## Risk Assessment

- **JSONL shape variance:** mitigated by defensive parsing + fallback to `tool_start`/`tool_end`. Verified 3+ transcripts; array form is normal, string form is rare (model error).
- **`tool_use` no `id`:** accepted — `requestId` is a generated UUID. No correlation back to JSONL needed (answers are the next `user_message`, not extracted).
- **`description` field size:** options can have long descriptions. `truncatePayload` (4KB) applies to the whole `questions` payload — sufficient for typical AskQuestion (≤9 questions, ≤5 options each).

## Security Considerations

- No new HTTP endpoints; no auth surface change.
- `truncatePayload` (4KB) applies to questions — prevents a pathological transcript from bloating the event log.
- Hydrator reads from `~/.cursor/projects/...` — same path trust model as existing handoff.

## Next Steps

- Phase 1 renders the new events in the transcript (questions + options inline; no lazy-load — user answer is the next user bubble).
