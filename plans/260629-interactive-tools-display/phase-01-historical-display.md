# Phase 01 — Historical Display (transcript inline block)

**Priority:** P1 (user-visible improvement)
**Status:** Not started
**Depends on:** Phase 0 (event types + hydrator emits them)
**Estimated:** 0.5 day
**Lane:** B (frontend) + C (tests)
**Commit:** 2 of 4 in the PR

## Context Links

- [Plan overview](./plan.md)
- [Phase 0](./phase-00-shared-contract.md) — emits `user_input_requested` / `user_input_resolved` (without answers)
- Transcript builder: `apps/web/src/lib/transcript-build-blocks.ts`
- Transcript renderer: `apps/web/src/components/session-transcript.tsx`
- Existing tool renderer: `apps/web/src/components/transcript-blocks/tool-call-block.tsx`

## Overview

Render a structured questionnaire block inline in the transcript when the event log contains `user_input_requested` (and a paired `user_input_resolved` for historical imports). The block shows the title, each question with its prompt, and the options (with descriptions). **No lazy-load, no answers extraction** — the user's answer appears as the next user bubble in the transcript (already rendered by the existing `UserBlock` component). Read-only — no submit button in this phase.

## Key insights

- **Inline placement, not at end of turn** (locked decision 2026-06-29). Matches Cursor IDE UX — the question appears where the agent asked it, the user's answer appears right after as a user bubble.
- **No lazy-load.** The event payload has `questions` (with options + descriptions). That's everything needed to render the block. The user's answer is the next `user_message` event, already rendered by `UserBlock`. No fetch, no loading state, no "Answers unavailable" path.
- **Read-only.** Historical imports always have `user_input_resolved`; live runs today don't emit `user_input_requested` at all (verified). So every block rendered in this phase has both halves. A pending-only block (no resolved) is Phase 2's banner concern, not transcript.
- **One new `TranscriptBlock` variant:** `user_input` with `requestId`, `title?`, `questions`, `resolvedBy?`. No `answers` field.
- **Performance:** the block is `memo()`; renders are O(questions × options) which is tiny (Cursor caps AskQuestion at ~9 questions). No state, no effects, no refs.
- **Reuse `tool-summary` style** for the collapsed header: "Asked N questions" with a chevron, mirroring `ToolGroup`'s `summarizeToolGroup`.
- **`description` rendering:** each option shows `label` prominently and `description` as muted helper text below (if present). Mobile-friendly: descriptions wrap, don't truncate.

## Requirements

### Functional

- New `TranscriptBlock` variant: `{ kind: 'user_input'; requestId: string; title?: string; questions: UserInputQuestion[]; resolvedBy?: 'user' | 'timeout' | 'skip' | 'provider' }`. **No `answers` field.**
- `buildTranscriptBlocks` handles `user_input_requested` (opens a block) and `user_input_resolved` (closes it, sets `resolvedBy`). Pair by `requestId`.
- New component `UserInputBlock` renders:
  - Collapsed: "Asked N question(s)" + chevron (matches `ToolGroup` header style)
  - Expanded: title (if present), each question (header if present, prompt), options as a vertical list — each option shows `label` prominently + `description` as muted text below (if present)
  - `resolvedBy === 'skip'` or `timeout` → small muted label "Skipped" / "Timed out"
  - `resolvedBy === 'user'` or undefined → no special label (the answer is the next user bubble, naturally visible)
- `Transcript` (`session-transcript.tsx`) renders the new block kind via `RenderItemView` switch — exhaustive `never` check in default preserved.
- `api.ts` exports the new event payload types for the frontend (typed `SessionEvent['type']` union if strict, or document the new payload shapes).

### Non-functional

- `UserInputBlock` is `memo()`; re-renders only when its props change (rare — historical blocks are immutable).
- No change to SSE hook or event log fetching — new events flow through unchanged.
- Mobile-friendly: options render as a vertical list (tap targets ≥ 32px), descriptions wrap.

## Architecture

```
buildTranscriptBlocks(events)
  ...
  if event.type === 'user_input_requested':
    flushAssistant()
    open a user_input block { requestId, title, questions, resolvedBy: undefined }
    push to out
  if event.type === 'user_input_resolved':
    find the open block by requestId in `out`
    if found: set resolvedBy on it (NO answers — user answer is next user_message)
  # the next user_message event renders as a UserBlock naturally (existing behavior)

UserInputBlock (React component) — stateless, memo()
  props: { block }
  state: { open: boolean } (local, just for collapse)
  render:
    collapsed: "Asked N questions" + chevron
    expanded: title + questions + options (with descriptions) + resolvedBy label
```

**Pairing strategy:** `user_input_requested` and `user_input_resolved` are emitted as a pair for historical imports, so the block is complete when first pushed (with `resolvedBy` set). The "find and update" path handles the future live case where `resolved` arrives later.

## Related code files

**Modify:**
- `apps/web/src/lib/api.ts` — extend `SessionEvent` type union (if typed) or document the new payload shapes
- `apps/web/src/lib/transcript-build-blocks.ts` — new `TranscriptBlock` variant + handling
- `apps/web/src/components/session-transcript.tsx` — render `user_input` block in `RenderItemView`
- `apps/web/src/components/transcript-blocks/tool-group.tsx` (optional) — extract the "Asked N questions" header style if it shares code with tool group headers

**Create:**
- `apps/web/src/components/transcript-blocks/user-input-block.tsx`
- `apps/web/src/components/transcript-blocks/user-input-block.spec.tsx`
- Extend `apps/web/src/lib/transcript-build-blocks.spec.ts` — new event pairing

**Delete:** none.

## Implementation steps (TDD-first)

1. **Red — `transcript-build-blocks.spec.ts`:**
   - Events `[user_input_requested { requestId, questions: [Q1, Q2] }, user_input_resolved { requestId, resolvedBy: 'user' }]` → blocks has one `user_input` block with `questions.length === 2` and `resolvedBy === 'user'` (no `answers` field on the block)
   - `user_input_requested` alone (no resolved) → block with `resolvedBy: undefined` (future live case)
   - `user_input_resolved` with no matching `requested` → ignored (defensive)
   - Multiple sequential `user_input_requested` with different `requestId` → two separate blocks
2. **Green — extend `transcript-build-blocks.ts`:** add the variant + handling (no answers extraction).
3. **Red — `user-input-block.spec.tsx`:**
   - Renders "Asked 2 questions" header when collapsed
   - Expanding shows both questions with their options (label + description if present)
   - Option with `description` shows muted helper text below the label
   - Option without `description` shows only label (no empty space)
   - `resolvedBy: 'skip'` → "Skipped" label visible
   - `resolvedBy: 'user'` → no special label (answer is the next user bubble)
   - `title` present → rendered as a heading
   - `title` absent → no empty heading
4. **Green — `user-input-block.tsx`:** implement with shadcn primitives where applicable (`Badge` for the count, `ChevronDown` from lucide). Use nova tokens — no raw hex. Descriptions in `text-muted-foreground` muted style.
5. **Wire into `session-transcript.tsx`** `RenderItemView` switch — add `case 'user_input': return <UserInputBlock block={block} />`. Keep the `never` check in default. **No `sessionId` prop needed** (no lazy-load).
6. **Update `api.ts`** types if the union is strict (check current definition — `type: string` is loose today, so this may be a no-op).
7. **Refactor** under green: if `UserInputBlock` grows past ~120 lines, split into `UserInputQuestion` sub-component.

## Todo List

- [ ] Write `transcript-build-blocks.spec.ts` cases (red)
- [ ] Extend `transcript-build-blocks.ts` (green)
- [ ] Write `user-input-block.spec.tsx` (red)
- [ ] Implement `user-input-block.tsx` (green)
- [ ] Wire into `session-transcript.tsx`
- [ ] Update `api.ts` types if needed
- [ ] Run `bun run --filter @nuncio/web test` — green
- [ ] Run `bun run --filter @nuncio/web build` — green
- [ ] Run `bun run --filter @nuncio/web lint` — green
- [ ] Visual check against `mockup.html` (light + dark) — block doesn't break transcript layout
- [ ] Visual check: imported session with AskQuestion → questions/options render inline, user answer appears as next bubble
- [ ] Commit (Phase 1 — `feat: render AskQuestion as structured transcript block`)
- [ ] Code review pass

## Success Criteria

- An imported handoff session with an AskQuestion in the transcript renders a structured questionnaire block (title, questions, options with descriptions) instead of a `Used AskQuestion` generic row
- The user's answer to the question appears as the next user bubble (existing `UserBlock` behavior, unchanged)
- `bun run --filter @nuncio/web test` green (existing + new specs)
- `bun run --filter @nuncio/web build` green
- `bun run --filter @nuncio/web lint` green
- Light + dark mode render correctly (no raw hex, nova tokens only)
- Mobile width (375px) — options + descriptions wrap, no horizontal scroll
- No existing transcript test breaks

## Risk Assessment

- **`buildTranscriptBlocks` complexity grows:** the function is already ~190 lines. Adding a new event type adds ~15. If it crosses ~250, extract a `buildUserInputBlocks` helper. Watch this in review.
- **`SessionEvent['type']` is `string` today:** no compile-time exhaustiveness to break. Acceptable — the runtime switch + `never` check in `RenderItemView` is the safety net.
- **Long descriptions:** some option descriptions can be multi-sentence. Render as wrapped text, not truncated — the user needs the full context to understand what was asked.

## Security Considerations

- Read-only display; no user input accepted in this phase.
- Question/option/description text comes from the agent (Cursor transcript) — same trust level as `assistant_message` text. Rendered as text, not HTML (React escapes by default).

## Next Steps

- Phase 2 adds the composer banner for live pending questions (which today never fire from `@cursor/sdk`, but the shell is ready for future providers / ACP).
