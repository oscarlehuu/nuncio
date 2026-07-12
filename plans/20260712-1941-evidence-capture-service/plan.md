# Mission E1 — Provider-neutral evidence capture

## Outcome

Add a headless Playwright/Chrome capture service that stores PNG bytes through `MediaStore`, appends provider-neutral `evidence_captured` session events, exposes an explicit sessions API, and folds those events into portable core transcript blocks. No web renderer, Pi-engine, or mobile changes.

## Grounded decisions

- Keep `playwright-core` at the workspace root: it already exists in root `devDependencies` and `bun.lock`; do not duplicate it in `apps/server/package.json` unless server package resolution/build proves it unavailable.
- Reuse `apps/server/src/sessions/media.store.ts`; events contain only `{ id, mimeType: 'image/png' }` refs, never screenshot base64.
- Launch `chromium.launch({ channel: 'chrome', headless: true })`; configurable executable fallback may mirror the existing Chrome paths, but never require DISPLAY or a visible window.
- Capture against `new URL(route ?? '/', url)`, report the normalized route, fixed/default viewport, and `git rev-parse HEAD` from `worktreePath ?? workspace ?? projectPath`.
- Auto-hook caveat: `TasksRepository.claimNextQueued()` marks a task `RUNNING` before a newly-created session or preview URL exists; preview URLs are not persisted. Implement a TODO-free best-effort `captureKnown(sessionId, phase)` seam: remember URLs supplied to the explicit API, optionally resolve an already-open session browser URL, no-op when unknown. Call before `awaitRun()` for an existing/attached session and before terminal finish for after; do not fake capture for brand-new tasks lacking a URL.

## TDD implementation order

1. **Red — event/core contracts.** Add server payload-shape tests in `apps/server/test/unit/sessions/events.types.spec.ts`; add `packages/core/src/evidence.types.ts` tests and an `evidence_captured` folding case in `packages/core/src/transcript-build-blocks.spec.ts`.
2. **Green — shared types/fold.** Add `EvidenceCapturedPayload` (`beforeRef?`, `afterRef?`, `route`, `viewport:{w,h}`, `workspaceHead`) to `apps/server/src/sessions/domain/events.types.ts`; mirror/export it from `packages/core/src/evidence.types.ts` and `packages/core/src/index.ts`; add `{ kind:'evidence'; key; evidence }` and defensive projection in `packages/core/src/transcript-build-blocks.ts`.
3. **Red — capture service.** Create `apps/server/test/unit/evidence/evidence-capture.service.spec.ts` with injected/mocked Playwright launcher, page/context/browser, `MediaStore`, session lookup, event append, git-head reader; cover URL/route normalization, viewport, PNG ref by phase, headless launch, closure on success/failure, missing session/cwd/head, and no base64 in payload.
4. **Green — evidence module.** Create `apps/server/src/evidence/evidence.types.ts`, `evidence-capture.service.ts`, and `evidence.module.ts`; inject abstractions/tokens for Playwright and git execution, import/export the existing session/media dependencies without creating a second store, and register `EvidenceModule` in `apps/server/src/app.module.ts`.
5. **Red/green — API.** Extend `apps/server/test/unit/sessions/sessions.controller.spec.ts` for `POST :id/evidence`, required valid `url`, optional `route`, and strict `phase`; add the DTO and controller method in `apps/server/src/sessions/api/sessions.controller.ts`, injecting `EvidenceCaptureService`, returning the capture result/refs and normal Nest 400/404 errors.
6. **Red/green — lifecycle hook.** Add focused `apps/server/test/unit/tasks/tasks.service.spec.ts` cases proving known URLs trigger best-effort before/after captures, unknown URLs no-op, and capture failures cannot alter task settlement. Inject `EvidenceCaptureService` optionally through `apps/server/src/tasks/tasks.module.ts`; call the minimal hook in `apps/server/src/tasks/tasks.service.ts` at the grounded seams above.
7. Refactor files toward <200 lines where practical; retain clear ownership between capture orchestration, DTO/contracts, and Nest wiring.

## Verification and delivery

- Install first: `bun install --frozen-lockfile` (use cache/offline behavior if network is blocked).
- From `apps/server`: `bun run lint`; `bun test test/unit/`. Record exact pass/fail counts; isolate only proven sandbox `EPERM` listener failures.
- From `packages/core`: `bunx vitest run`.
- Also run root `bun run gate` before commit if time/environment permits; run a code-review pass and fix blockers.
- Update `README.md` with API/event architecture and headless behavior; add a minor changeset because this is a new API capability (`bun run add-changeset minor "Added provider-neutral screenshot evidence capture for session previews."`), then `bun run check-changeset`.
- Stage only Mission E1 files (exclude `.bun-cache/` and `.tmp/`); conventional focused commit(s), no AI references. Attempt `git push origin feat/evidence-service`; report network failure without rewriting history.

## Success criteria

Explicit capture works end-to-end with real headless Chrome; durable events contain refs only; core emits an evidence block; known-URL task hooks are safe/best-effort; requested suites are green or only precisely documented sandbox-EPERM failures remain.

## Unresolved questions

None. The absent persisted preview URL is handled transparently by the bounded best-effort hook, not hidden by a schema expansion.
