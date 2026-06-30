# Phase 02 — Pending State Derivation + Composer Banner (read-only shell)

**Priority:** P2 (UI shell for future live respond)
**Status:** Not started
**Depends on:** Phase 0 (event types)
**Estimated:** 1 day
**Lane:** B (frontend) + C (tests)
**Commit:** 3 of 4 in the PR

## Context Links

- [Plan overview](./plan.md)
- [Phase 0](./phase-00-shared-contract.md) — events
- Steer composer: `apps/web/src/components/session-detail.tsx` (the `<Textarea>` + send button area)
- Reference (Synara): `apps/web/src/session-logic.ts` `derivePendingUserInputs`, `apps/web/src/components/chat/ComposerInputBanners.tsx`

## Overview

Add a pure `derivePendingUserInput(events)` function that folds the event log and returns any open `user_input_requested` without a matching `user_input_resolved`. Render the result as a composer banner **above** the steer textarea. In this phase the banner is **read-only** — no submit button — because no provider supports `submitInteraction` yet (Phase 3 declares the interface but Cursor/Pi stubs return `501`). The shell is ready for the future live-respond path.

## Key insights

- **Derivation is pure and separate from `buildTranscriptBlocks`.** Pending state is a projection over the event log; it must not re-render the transcript when it changes. Synara's `derivePendingUserInputs` is the reference: one fold, `Map<requestId, PendingUserInput>`, delete on `resolved`.
- **Banner precedence over the existing `machineActive` placeholder.** Order: pending user input > `machineActive` (Cursor IDE still running) > `RUNNING` > default. Documented in the component.
- **Read-only today, form-ready tomorrow.** The banner renders questions + options as a disabled form (greyed submit button with tooltip "Answering from phone is not yet supported for this provider"). When Phase 3 ships a real `submitInteraction`, the same component flips to enabled.
- **Performance:** derive in `useMemo([events])` at the `SessionDetail` level; pass the result down as a prop. The banner is `memo()`. Draft answers (when the form is enabled later) go in a `useRef` inside the banner, not in `SessionDetail` state — avoids re-rendering the transcript on every option toggle (Synara pattern).
- **Today no event log will actually contain an open `user_input_requested`** because the hydrator emits paired events and `@cursor/sdk onDelta` doesn't fire AskQuestion. So this phase is a **shell with no live trigger** — it's ready for the future, and the unit tests prove it works. The visible ship in this phase is the **historical display** (Phase 1), not the banner.

## Requirements

### Functional

- `derivePendingUserInput(events: SessionEvent[]): PendingUserInput[]` — pure fold:
  - `user_input_requested` with `requestId` + `questions` → add to open map
  - `user_input_resolved` with `requestId` → remove from open map
  - Returns array sorted by `createdAt` ascending
  - Defensive: missing `requestId` → skip; unparseable `questions` → skip
- `PendingUserInput` type: `{ requestId, createdAt, title?, questions: UserInputQuestion[] }`
- New component `PendingUserInputBanner`:
  - Props: `{ pending: PendingUserInput[], onRespond?: (requestId, answers) => void, supported: boolean }`
  - When `supported === false` (today, for Cursor + Pi): renders questions + options as a disabled form, submit button greyed with tooltip "Answering from phone is not yet supported for the {provider} provider"
  - When `supported === true` (future): renders an enabled form (submit calls `onRespond`)
  - Multi-question wizard: one question at a time with a step indicator (Synara pattern — simpler on mobile than a long scroll)
  - Cancel button emits `onRespond(requestId, [])` with `resolvedBy: 'skip'` semantics (only when `supported`)
- `SessionDetail` mounts the banner above the `<Textarea>`; derives `pending` via `useMemo`; passes `supported={false}` for now (Phase 3 will wire the real per-provider capability)
- Banner precedence: if `pending.length > 0`, hide the `machineActive` placeholder and the running/disabled steer hint; show the banner instead

### Non-functional

- `derivePendingUserInput` is O(n) over events; called in `useMemo` so it only re-runs when `events` reference changes (SSE hook creates a new array on each event)
- Banner is `memo()`; draft answers in `useRef` inside the banner
- No change to SSE hook, event log fetching, or `Transcript`
- Mobile-first: banner is sticky above the keyboard; options are large tap targets (≥ 40px height)

## Architecture

```
SessionDetail
  events = useSessionStream(id)
  pending = useMemo(() => derivePendingUserInput(events), [events])
  supported = false  // Phase 3 wires real capability per provider

  render:
    <Transcript events={events} streaming={streaming} />
    <PendingUserInputBanner pending={pending} supported={supported} />
    <Textarea ... />  // steer composer (unchanged)
```

**Banner internal state (when `supported`):**
- `questionIndex` (which question is active in the wizard)
- `answersRef` = `useRef<Record<questionId, Answer>>` (no re-render on toggle)
- Submit reads from the ref, calls `onRespond`

## Related code files

**Modify:**
- `apps/web/src/components/session-detail.tsx` — derive `pending`, mount banner, adjust placeholder precedence
- `apps/web/src/lib/api.ts` — export `PendingUserInput` type if not already (frontend-only type)

**Create:**
- `apps/web/src/lib/derive-pending-user-input.ts`
- `apps/web/src/lib/derive-pending-user-input.spec.ts`
- `apps/web/src/components/pending-user-input-banner.tsx`
- `apps/web/src/components/pending-user-input-banner.spec.tsx`

**Delete:** none.

## Implementation steps (TDD-first)

1. **Red — `derive-pending-user-input.spec.ts`:**
   - Empty events → `[]`
   - `user_input_requested` alone → one pending entry
   - `user_input_requested` + matching `user_input_resolved` → `[]`
   - Two `requested` (different `requestId`) + one `resolved` → one pending (the unresolved one)
   - `user_input_resolved` with no prior `requested` → `[]` (defensive)
   - Missing `requestId` → skipped
   - Sorted by `createdAt` ascending
2. **Green — `derive-pending-user-input.ts`:** implement the fold.
3. **Red — `pending-user-input-banner.spec.tsx`:**
   - `pending=[]` → renders nothing
   - `pending=[one with 2 questions]`, `supported=false` → renders both questions, options disabled, submit button disabled with tooltip text matching the provider name
   - `supported=true` → submit button enabled; clicking calls `onRespond` with the draft answers
   - Multi-question wizard: only one question visible at a time; "Next" button advances; "Back" returns
   - Cancel button (only when `supported`) calls `onRespond(requestId, [])`
   - `resolvedBy: 'skip'` style — banner disappears when pending becomes `[]` (parent re-derive)
4. **Green — `pending-user-input-banner.tsx`:** implement with shadcn `Button`, `Badge` for step indicator, lucide `ChevronRight`/`ChevronLeft`. Nova tokens only.
5. **Wire into `session-detail.tsx`:**
   - `import { derivePendingUserInput } from '@/lib/derive-pending-user-input'`
   - `const pending = useMemo(() => derivePendingUserInput(events), [events])`
   - Render `<PendingUserInputBanner pending={pending} supported={false} />` above the `<Textarea>`
   - Adjust the `placeholder` logic: if `pending.length > 0`, the textarea stays disabled (user must answer first or skip — but skip is disabled today, so practically the textarea is just visually de-emphasized; document this)
6. **Refactor** under green: if `PendingUserInputBanner` crosses ~180 lines, split into `PendingUserInputQuestion` (single question view) + the wizard shell.

## Todo List

- [ ] Write `derive-pending-user-input.spec.ts` (red)
- [ ] Implement `derive-pending-user-input.ts` (green)
- [ ] Write `pending-user-input-banner.spec.tsx` (red)
- [ ] Implement `pending-user-input-banner.tsx` (green)
- [ ] Wire into `session-detail.tsx` with precedence logic
- [ ] Run `bun run --filter @nuncio/web test` — green
- [ ] Run `bun run --filter @nuncio/web build` — green
- [ ] Run `bun run --filter @nuncio/web lint` — green
- [ ] Visual check: with `pending=[]` (today's reality), banner is invisible and existing UX is unchanged
- [ ] Visual check: with a forced `pending` fixture, banner renders above textarea in light + dark
- [ ] Code review pass

## Success Criteria

- `bun run --filter @nuncio/web test` green (existing + new specs)
- `derivePendingUserInput` is pure, unit-tested, O(n)
- Banner is `memo()`; no unnecessary re-renders when transcript updates
- Today's UX is **unchanged** because no event log produces an open `user_input_requested` yet — verified by running the dev server and opening an existing session
- Banner precedence works: if a future event log has pending, it hides the `machineActive`/running placeholder
- Mobile width (375px) — banner wraps, no horizontal scroll, options are tappable
- No existing `session-detail.spec.tsx` test breaks (the banner adds a div, doesn't remove anything)

## Risk Assessment

- **Banner visible with no way to dismiss (today):** mitigated by `supported=false` rendering a clear tooltip + the banner only appears if `pending.length > 0`, which doesn't happen today. If a future bug emits an unpaired `user_input_requested`, the user can still steer (the textarea stays enabled — only the placeholder text changes). Document this in the component.
- **`useMemo([events])` re-runs on every SSE event:** acceptable — the fold is O(n) and Nuncio sessions are short. If a session ever exceeds ~1000 events, memoize on `events.length + lastSeq` instead. Note for future.
- **Wizard vs single-page:** wizard is more code but better on mobile. If review pushes back, single-page is a quick fallback (render all questions in a scroll list). Keep the wizard — Synara validates the pattern.

## Security Considerations

- No new HTTP endpoints in this phase (the banner is display-only).
- When `supported=true` lands in Phase 3, `onRespond` will POST to `/api/sessions/:id/interactions/:callId/respond` — that endpoint must validate the session is `RUNNING` and the `requestId` matches an open pending. Tracked in Phase 3.

## Next Steps

- Phase 3 declares the `submitInteraction` interface on `AgentProvider`, marks Cursor/Pi as unsupported, adds the HTTP endpoint stub (`501`), updates docs + changeset, ships.
