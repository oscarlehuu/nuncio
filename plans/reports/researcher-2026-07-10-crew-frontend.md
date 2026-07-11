# Crew MVP frontend research

**Status:** DONE
**Scope:** existing web/PWA + Expo UX, smallest Crew UI, client contracts, and acceptance coverage. No production code changed.

## Recommendation

Keep one Nuncio experience. Add **Solo / Crew** to the existing task composer; Solo preserves the current provider/model flow, Crew swaps the model picker for one saved profile and a server-resolved team preview. Add one **Crew profiles** Settings pane and one focused **CrewTask detail** route. Do not turn `SessionDetail` into a workflow dashboard and do not merge member transcripts into one chat.

This fits the product: async phone-first control surface (`docs/product-vision.md:41-43`, `docs/product-vision.md:75-82`), engine-neutral UI (`docs/product-vision.md:35-37`, `docs/architecture-decisions.md:47-60`), fixed guarded Crew workflow (`docs/crew-workspace-harness.md:344-378`), and user-owned irreversible authority (`docs/crew-run-authority-and-state-machine.md:22-25`, `docs/crew-run-authority-and-state-machine.md:67-84`).

## Existing UX worth preserving

| Surface | Evidence | MVP implication |
|---|---|---|
| New task | `apps/web/src/components/home-view.tsx:202-235` keeps project/branch/workspace above one composer; model sits in its bottom bar at `:292-307`; Send remains fixed at `:327-336`. | Add mode + model/profile inside the existing picker strip. No new wizard or route. |
| Model selection | `apps/web/src/components/model-picker.tsx:489-493` already supports `(engine, model)` pair mode. Its panel is viewport-bounded and internally scrollable at `:183-188`, `:217-261`; pair-mode phone behavior is pinned by `apps/web/src/components/model-picker.spec.tsx:425-545`. | Reuse this picker for profile role bindings. Do not build a Crew-only model selector. |
| Settings | Section/deep-link model is explicit at `apps/web/src/components/settings-view.tsx:45-83`, content swaps at `:392-425`; nav becomes a horizontal scroller on small screens at `apps/web/src/components/settings-section-nav.tsx:16-25`. | Add `crew-profiles` as one peer section; use the existing list + edit-dialog idiom. |
| Session detail | Current detail owns one provider session (`apps/web/src/components/session-detail.tsx:92-132`) and is already 1,163 lines. It has a centered dense header (`:609-771`), transcript (`:773-810`), and composer/pending-input region (`:813-975`). | New CrewTask route/components; share primitives, not provider-session state. Put progress below the header, not in it. |
| Delegation UI | Existing compact subagent rows + read-only handoff brief are at `apps/web/src/components/subagents-panel.tsx:45-80`, `:155-190`; completed work projects into a digest card at `apps/web/src/components/transcript-blocks/task-digest-card.tsx:42-119`. | Reuse density, status vocabulary, disclosure, and member-session links. Do not expose hidden/member reasoning by default. |
| Pure projections | Transcript blocks are a shared union at `packages/core/src/transcript-build-blocks.ts:16-77`; event-to-digest projection is defensive at `:79-120` and table-tested at `packages/core/src/transcript-build-blocks.spec.ts:447-545`. | CrewRun phase/gate/member projection belongs in `packages/core`, table-tested before React. |
| Attention | Queue preserves server order (`apps/web/src/components/attention-queue.tsx:19-49`, `:95-113`) and unknown kinds degrade safely (`apps/web/src/lib/attention-kind.ts:28-44`). | Crew blockers join the one queue; no second Crew inbox. |
| Mobile | PWA already has safe-area/touch rules (`apps/web/src/index.css:307-353`). Expo new-session is prompt + flat model list only (`apps/mobile/src/app/new.tsx:21-51`, `:65-104`); Expo detail is one session transcript (`apps/mobile/src/app/session/[id].tsx:28-67`, `:116-170`). | PWA gets full MVP. Expo selects saved profiles and operates runs; profile editing stays web/PWA. |
| Real-browser gate | Visual work must reach Chrome (`docs/testing-and-verification.md:39-53`). Existing hermetic smoke covers create/stream/steer/archive and delegation (`scripts/smoke-ui.mjs:88-170`, `:171-249`). | Extend this smoke, do not create a parallel harness. |

## Smallest user flow

### 1. Create: Solo or Crew

1. Existing Home composer opens in **Solo**. Solo remains byte-for-byte behavior-compatible and still sends provider/model/options.
2. Compact two-option radiogroup appears in the existing `.home-composer-pickers` strip: `Solo` / `Crew`. Send stays outside the horizontal scroller.
3. Solo shows existing `ModelPicker`. Crew replaces it with `CrewProfilePicker`; Codex approval control disappears because the resolved profile owns member permissions.
4. When Crew is selected, server resolves `profile + project + live capabilities`. Show one compact preview inside the existing prompt-control area:
   - `Ready` — `Foreman · Fable → Builder · Sol → Verify → Reviewer · Opus`.
   - `Adjusted` — amber, exact fallback delta visible. If server says confirmation required, Delegate stays disabled until acknowledged.
   - `Needs setup` — reason + `Set up profile` deep-link to `/settings?section=crew-profiles`; Delegate disabled.
5. Delegate creates one CrewTask + immutable CrewRun snapshot, then navigates to `/crew/:taskId`.

Selection default: Solo every fresh composer. On switching to Crew, ask the server to choose explicit selection > project default > sole/last ready profile. Never silently switch provider/model client-side. Profile resolution and non-silent fallback are agreed at `docs/crew-workspace-harness.md:84-115`.

No temporary per-run member overrides in MVP. The design allows an advanced disclosure later (`docs/crew-workspace-harness.md:45-46`), but it adds validation and accidental profile-drift risk now.

### 2. Manage Crew profiles

Add **Crew profiles** after Agents in Settings.

- List row: name, preset (`Quality`), `Ready / Adjusted / Needs setup`, resolved-team summary, Edit.
- Primary action: `New profile`. Edit in one dialog/sheet; no nested settings page.
- Fields: name; Foreman/Builder/Reviewer engine+model; deterministic Tester row (`Nuncio · project verify command`); require verify; require review; max fix/review rounds.
- Use `ModelPicker pairMode="engine+model" autoPick={false}` with a role-filtered catalog. Server remains final validator for capabilities and reviewer independence.
- Strict fallback is enough for first UI. Display server-reported adjustments; do not build a fallback-rule editor.
- Editing affects future runs only. Active detail says `Profile snapshot · <name> · revision N`, matching `docs/crew-workspace-harness.md:107-115`.

### 3. CrewTask / CrewRun detail

Use a new focused route, not a conditional branch inside `SessionDetail`.

Top to bottom:

1. Existing-style header: task title; overflow with Pause/Resume/Cancel/Archive. No provider/model pill.
2. `CrewRunProgress`: ordered steps from resolved snapshot. Plan → Build → Verify → Review → Synthesize; Approval/Publish only when configured. Disabled gates remain visible as `Skipped by profile` for audit. Current step has `aria-current="step"`.
3. One-line live summary: both dimensions, e.g. `Build · Running · Sol · round 2`. Never flatten `(phase, status, outcome)`; the authoritative tuple is defined at `docs/crew-run-authority-and-state-machine.md:106-163`.
4. `Members` disclosure: fixed roles, provider/model, current state, `Open member session`. No model changes after launch; no merged transcripts.
5. Timeline: objective/user changes, bounded foreman/member summaries, workspace advances, verify/review evidence, recovery, synthesis. Reuse quiet divider/card language from task digest and verify rows.
6. Bottom action surface:
   - active: `Steer the crew` / add context;
   - clarification: answer the typed question;
   - round cap: `Run one more round` or `Accept exception`;
   - approval: `Approve publish` or `Keep local`;
   - terminal: `Request a change` creates a successor run, never reopens terminal history.

For MVP live updates, polling the server-projected run summary while non-terminal is enough; the existing child-task panel already uses guarded 4s polling (`apps/web/src/components/session-detail.tsx:379-397`). Do not infer phase from member Session events and do not change the frozen session WS contract solely for UI polish.

### 4. Gates and Attention

Gate states needed: `pending`, `running`, `passed`, `failed`, `changes_requested`, `skipped`, `stale`, `waived`. Evidence always carries workspace head. A head change turns old green evidence into `Stale`, never green (`docs/crew-workspace-harness.md:171-172`, `docs/crew-run-authority-and-state-machine.md:230-245`). An accepted exception keeps failed evidence visible and ends amber as `Succeeded with exceptions` (`docs/crew-run-authority-and-state-machine.md:160-163`, `:319-335`).

Add Crew blockers to the existing Attention queue with payload `{ crewTaskId, crewRunId, reason }`; Open deep-links to the exact run. Keep risky actions in detail beside evidence. Home gets `Open` plus `Mark seen`, never `Accept exception`.

Important mismatch: the core already exposes ack (`packages/core/src/attention-api.ts:68-80`), but Home currently wires `Dismiss` to terminal resolve (`apps/web/src/components/attention-queue.tsx:60-77`, `:98-111`; pinned by `apps/web/src/components/inbox-view.spec.tsx:102-121`). For a live Crew blocker, Dismiss must not advance the run or suppress the only reminder. Use ack/Seen for Crew items; exception/approval remains an explicit CrewRun action.

## Minimal client contract

Client should consume server truth, not rebuild profile resolution:

```ts
type CrewProfileState = 'ready' | 'adjusted' | 'needs_setup';
type CrewRunPhase = 'PLAN' | 'BUILD' | 'VERIFY' | 'REVIEW' | 'SYNTHESIZE' | 'APPROVAL' | 'PUBLISH' | 'DONE';
type CrewRunStatus = 'QUEUED' | 'RUNNING' | 'BLOCKED_USER' | 'BLOCKED_PROVIDER' | 'PAUSED' | 'RECOVERING' | 'TERMINAL';

interface ResolvedCrewProfileDto {
  profileId: string;
  profileRevision: number;
  profileName: string;
  state: CrewProfileState;
  members: Array<{ role: string; provider: string; model: string; label: string }>;
  gates: Array<{ kind: 'verify' | 'review'; enabled: boolean; command?: string }>;
  adjustments: Array<{ role: string; from: string; to: string; reason: string }>;
  confirmationRequired: boolean;
  issues: string[];
}
```

CrewRun DTO also needs `taskId`, `runId`, phase/status/outcome, immutable profile snapshot, rounds, members, head-bound gates, typed attention reason, priorRunId, timestamps. Put this in a new `packages/core/src/crew-api.ts`; `packages/core/src/api.ts:268-311` is already a positional Solo-create API and should not gain more optional parameters.

## Exact files likely touched

### Shared/core

- New: `packages/core/src/crew-api.ts`, `packages/core/src/crew-run-projection.ts` and matching `*.spec.ts`.
- Update: `packages/core/src/index.ts`; `packages/core/src/attention-api.ts` only for known Crew-kind typing if desired.
- Keep Crew events separate from `packages/core/src/transcript-build-blocks.ts`; member Session transcripts stay provider-session data.

### Web/PWA

- Update: `apps/web/src/components/home-view.tsx`, `home-view.spec.tsx`, `home-surface.tsx`, `apps/web/src/App.tsx`.
- New: `apps/web/src/components/crew/execution-mode-picker.tsx`, `crew-profile-picker.tsx`, `resolved-crew-preview.tsx` plus specs.
- Update: `apps/web/src/components/settings-view.tsx`, `settings-view.spec.tsx`.
- New: `apps/web/src/components/crew/crew-profiles-settings-section.tsx`, `edit-crew-profile-dialog.tsx` plus specs.
- New: `apps/web/src/components/crew/crew-task-detail.tsx`, `crew-run-progress.tsx`, `crew-members-panel.tsx`, `crew-gates.tsx` plus specs.
- Update: `apps/web/src/lib/attention-kind.ts`, `attention-kind.spec.ts`, `apps/web/src/components/attention-row.tsx`, `attention-queue.tsx`, `inbox-view.spec.tsx` for Crew deep-link + ack behavior.
- Update only if mixed Solo/Crew recents share the session feed: `apps/web/src/components/sidebar.tsx`, `sidebar.spec.tsx`.
- Extend: `scripts/smoke-ui.mjs`.

### Expo

- Update: `apps/mobile/src/app/new.tsx` (mode, saved profile, project), `apps/mobile/src/app/index.tsx` (mixed work rows), `apps/mobile/src/app/_layout.tsx` (Crew push deep-link), `apps/mobile/src/lib/push-registration.ts` and spec.
- New: `apps/mobile/src/app/crew/[taskId].tsx` with progress, gates, typed actions.
- Profile CRUD is not native-MVP; link to web/PWA Settings when setup is required.

## TDD acceptance matrix

| Level | Required red-first scenarios |
|---|---|
| Core projection | Every legal phase/status/outcome display; recovery preserves phase; workspace advance stales prior verify/review; skipped gate stays visible; waived failure stays failed and final outcome is exception-bearing; duplicate event idempotent; malformed/old payload degrades safely. |
| Home component | Defaults Solo; current Solo payload unchanged; Crew hides model/approval picker; Ready profile enables Delegate; Needs setup disables it and links Settings; Adjusted fallback is visible and confirmation-gated; project/profile change re-resolves without mutating saved profile. |
| Profile settings | List/empty/error; create/edit/delete; incompatible binding error attached to role; reviewer independence failure; live model disappears; active-run snapshot unchanged after save; mobile dialog remains viewport-bounded. |
| Crew detail | `aria-current` follows phase; `BLOCKED_PROVIDER`/`RECOVERING` do not advance step; current round visible; member session opens; stale/waived/skipped gate semantics; typed blocker exposes only valid actions; terminal change creates successor UI. |
| Attention | Crew kinds preserve server order, human label, exact deep-link; Mark seen calls ack; Dismiss/resolve cannot complete or waive a CrewRun; unknown future reason still opens run. |
| Responsive | 390px: Send remains visible; preview wraps; no page-level horizontal scroll; action buttons are 44px; long profile/model/branch/command truncates with accessible full label; keyboard does not cover action surface. |

Run web component tests, build/lint, server API/e2e, then Level 5. Visual/interactivity cannot stop at jsdom (`docs/testing-and-verification.md:27-31`, `:39-53`).

### Level-5 smoke extension

Use the existing hermetic Mock stack:

1. Create a temp git repo + Ready Mock Crew profile through real API.
2. Through UI select Crew, profile, project; assert resolved preview; Delegate.
3. Assert URL `/crew/<taskId>`, steps advance in order, Verify/Review show current-head evidence, final success appears.
4. Open one member session and return.
5. Repeat at 390×844; assert preview/action layout and no horizontal overflow.
6. Capture light + dark screenshots. Existing smoke already owns screenshots and cleanup (`scripts/smoke-ui.mjs:56-85`, `:259-272`).

## Computer Use acceptance scenarios

1. **Happy path, Electron:** Settings → Crew profiles → create `Smoke Quality Crew` using Mock roles → Home → Crew → select profile/project → verify exact resolved team → Delegate. Observe Plan → Build → Verify → Review → Synthesize → Done. Assert one shared worktree, member links, green current-head gates, and profile snapshot label.
2. **Gate cap + exception:** profile verify command deterministically fails and cap is 1. Run reaches `Verify · Waiting for you`; Home shows one Crew attention item. Open it, inspect failed command/head, approve one round, fail again, choose Accept exception only after confirmation. Assert verify remains red, outcome amber `Succeeded with exceptions`, no label says passed.
3. **Restart recovery:** while Build is running, quit/restart daemon/app. Reopen same CrewTask. Assert phase remains Build, status becomes Recovering, then resumes or blocks with a typed recovery reason; no duplicate member/result/publish action.
4. **Immutable profile snapshot:** start Run 1, edit the saved Builder model, return. Run 1 still shows original revision/model. Request a change/new Run 2; Run 2 resolves the new revision and links prior run.
5. **Narrow window:** resize Electron/web surface to phone width. Mode/profile controls remain reachable, resolved team wraps, gate actions stack, keyboard focus order follows visual order, Escape/overlay closes menus, no clipped popup or hidden Send.
6. **Provider loss:** make Reviewer unavailable after Build. Detail shows `Review · Provider unavailable`, not Failed/Done. If fallback needs confirmation, only the user can accept it; model/provider never changes silently.

## Accessibility and mobile edge cases

- Mode = labelled radiogroup; profile picker has visible label and state in accessible name.
- Stepper = ordered list, text + icon + color, `aria-current="step"`; one restrained `aria-live="polite"` summary, not every streamed event.
- `Adjusted`, stale evidence, warnings, failures, and exceptions never rely on color alone.
- Touch targets ≥44px; action buttons always visible, not hover-only. Respect existing reduced-motion behavior (`apps/web/src/index.css:427-451`).
- Long model/profile names truncate only visually; tooltip/accessibility name retains full value.
- Empty/no-ready profile, deleted profile, model removed mid-edit, offline catalog, slow resolution, duplicate tap, stale resolution revision, project change, daemon restart, and two tabs must not create duplicate runs.
- Profile picker/menu must fit `100vw - 24px`; bottom action surface honors iOS safe area.
- Expo shows progress/gates/actions, not raw all-member transcripts. Push payload must support `crewTaskId`/`crewRunId`; current handler only recognizes `sessionId` (`apps/mobile/src/app/_layout.tsx:20-25`).

## Explicit non-goals

- No DAG/workflow editor, arbitrary phases, recursive delegation, or dynamic roles.
- No parallel writers, merge/integration stage, multiple specialist reviewers, distributed crews.
- No profile import/export/marketplace, fallback-rule builder, cost optimizer, or adaptive routing.
- No per-run member override in the first UI.
- No autonomous publish/merge/deploy UI; keep local completion unless user explicitly expands MVP.
- No merged full transcripts or hidden reasoning transfer; member transcripts remain drill-down only.
- No Crew visual rebrand, avatars/personas, animated orchestration map, new Home/Fleet area, or second Attention inbox.
- No native Expo profile editor in MVP.

## Unresolved questions

1. **Plan approval:** recommend auto-proceed inside a valid profile; block only material questions. Still user-owned (`docs/crew-run-authority-and-state-machine.md:341-342`).
2. **Completion approval:** recommend green verify + clean review auto-completes locally; explicit approval only for publish/destructive work.
3. **Gate policy:** recommend blocker findings block, warnings remain visible; verify/review exception requires explicit evidence-first confirmation. Confirm whether exception-bearing runs may publish.
4. **Round caps:** recommend separate verify and review caps; confirm values.
5. **Publishing:** recommend local-only MVP, hiding Approval/Publish steps until enabled. Confirm whether approval-gated PR/MR creation is in first release.
6. **Continuation:** recommend one stable CrewTask with immutable successor CrewRuns, matching the draft; confirm before final route/API naming.
7. **Default selection:** recommend Solo on fresh composer; when Crew is chosen, project default profile then last/sole Ready profile. Confirm whether mode itself may be project-defaulted.

**Status:** DONE
**Concerns:** UX can proceed with the working recommendations, but questions 1–7 remain explicit product decisions, not locked ADRs.
