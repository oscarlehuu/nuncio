# Phase 03 — Provider Execution Interface Stub + Docs + Changeset

**Priority:** P3 (interface readiness + ship gate)
**Status:** Not started
**Depends on:** Phase 0 (events), Phase 2 (banner reads `supported`)
**Estimated:** 0.5 day
**Lane:** A (backend interface) + C (docs, changeset, tests)
**Commit:** 4 of 4 in the PR

## Context Links

- [Plan overview](./plan.md)
- [Phase 0](./phase-00-shared-contract.md) — events
- [Phase 2](./phase-02-pending-banner.md) — banner reads `supported` prop
- Provider interface: `apps/server/src/agents/agents.types.ts`
- Cursor provider: `apps/server/src/agents/providers/cursor-agent.provider.ts`
- Pi provider: `apps/server/src/agents/providers/pi-agent.provider.ts`
- Registry: `apps/server/src/agents/agents.registry.ts`

## Overview

Declare the optional `submitInteraction` method on `AgentProvider` so the contract is ready for a future SDK that exposes live respond. Wire a per-provider capability flag (`supportsInteraction(): boolean`) that the frontend reads via the existing session detail endpoint (or a new field). Add an HTTP endpoint stub that returns `501 Not Implemented` for any provider that doesn't support it. Update `README.md` + `AGENTS.md` to document the contract and the explicit `@cursor/sdk` limitation. Write the changeset. This phase **ships** the plan.

## Key insights

- **Interface-only, no execution.** `submitInteraction` is optional (`?` on the interface). Cursor and Pi providers **omit it** (or implement it as `throw 501`). The point is: when a future SDK release exposes AskQuestion respond, the contract is already there — no session-layer or UI-layer change.
- **Capability propagation, not feature flag.** The frontend banner needs to know whether the session's provider supports respond. Cleanest path: add `supportsInteraction: boolean` to `SessionDto` (resolved from `registry.resolveForSession(session).supportsInteraction?.() ?? false`). No env var, no settings store entry — it's a provider capability, not a user setting.
- **HTTP stub is a real endpoint.** `POST /api/sessions/:id/interactions/:requestId/respond` returning `501` for now. This locks the URL contract so the frontend `onRespond` can be wired today (calling it just shows an error toast); when a provider implements `submitInteraction`, the same endpoint flips to `200` with no client change.
- **No FSM change.** Pending state is a derived projection; the session stays `RUNNING` while a question is open. This is documented as a known limitation in `AGENTS.md` — `AWAITING_INPUT` is a future plan gated on real execution.
- **Changeset bump is `patch`**, not `minor`. The user-visible change in this whole plan is "imported transcripts render AskQuestion as a structured block instead of a generic tool row" — a display polish, not a new workflow. Per the versioning rubric: bug fix / polish / display → `patch`. Documenting the rubric reasoning in the changeset summary so review doesn't flag it.

## Requirements

### Functional

- `AgentProvider` interface gains:
  - `supportsInteraction?: () => boolean` (optional; defaults to `false` if omitted)
  - `submitInteraction?(sessionId: string, requestId: string, response: InteractionResponse, context: AgentRunContext): Promise<void>` (optional)
- `InteractionResponse` type: `{ answers: UserInputAnswer[]; resolvedBy: 'user' | 'skip' }`
- `AgentRegistry` gains `supportsInteraction(providerId: string): boolean` (resolves provider, calls `supportsInteraction?.() ?? false`)
- `SessionsService` gains `supportsInteraction(sessionId: string): boolean` (resolves provider via session row)
- `SessionDto` gains `supportsInteraction: boolean` (mapped in `SessionsRepository.toDto()` or the service layer)
- New HTTP endpoint: `POST /api/sessions/:id/interactions/:requestId/respond` with body `{ answers, resolvedBy }`:
  - If `!session.supportsInteraction` → `501` with `{ error: 'Provider does not support live interaction respond' }`
  - If provider supports but `submitInteraction` throws → `500` with the error message
  - On success → `200 { ok: true }` (the event log gets `user_input_resolved` with `answers` inline from the provider — this is the **live** path, distinct from the historical path where answers are never stored in events)
- **Note:** there is **no** `GET .../answers` endpoint in this plan. The historical display (Phase 1) renders questions + options from the event payload; the user's answer is the next `user_message` in the event log (already rendered by `UserBlock`). The `POST .../respond` endpoint (this phase) is for **live** respond only and returns `501` today.
- Cursor provider: omits both methods (defaults to `false`). Documented inline comment.
- Pi provider: omits both methods (defaults to `false`). Documented inline comment.
- Frontend `PendingUserInputBanner` reads `session.supportsInteraction` and passes it as the `supported` prop. `onRespond` POSTs to the new endpoint; on `501` shows a toast "Answering from phone is not yet supported for this provider" (reuses existing `SteerApiError` pattern from `api.ts`).

### Non-functional

- `supportsInteraction` is sync, cheap (no I/O) — safe to call per-request in `findOne()`.
- The new endpoint is behind the existing session-resolution middleware (no new auth).
- No DB migration — `supportsInteraction` is computed, not stored.

## Architecture

```
GET /api/sessions/:id
  SessionsService.findOne(id)
    session = sessions.repo.get(id)
    dto = toDto(session)
    dto.supportsInteraction = registry.supportsInteraction(session.provider)
    return dto

POST /api/sessions/:id/interactions/:requestId/respond
  SessionsService.respondInteraction(id, requestId, body)
    session = sessions.repo.get(id)
    if !registry.supportsInteraction(session.provider):
      throw 501
    provider = registry.resolveForSession(session)
    await provider.submitInteraction!(id, requestId, body, context)
    // provider is responsible for emitting user_input_resolved via context.emit
    return { ok: true }
```

## Related code files

**Modify:**
- `apps/server/src/agents/agents.types.ts` — add `supportsInteraction?` + `submitInteraction?` + `InteractionResponse` type
- `apps/server/src/agents/agents.registry.ts` — `supportsInteraction(providerId)` method
- `apps/server/src/sessions/sessions.service.ts` — `supportsInteraction()` + `respondInteraction()` + wire into `findOne()`
- `apps/server/src/sessions/api/sessions.controller.ts` — new `POST :id/interactions/:requestId/respond` route
- `apps/server/src/sessions/domain/sessions.types.ts` — `SessionDto.supportsInteraction` field
- `apps/server/src/sessions/persistence/sessions.repository.ts` — `toDto()` sets the field (or service layer does it)
- `apps/web/src/lib/api.ts` — `Session.supportsInteraction` field + `respondInteraction()` fetch helper + `InteractionApiError` (subclass of `SteerApiError`-style)
- `apps/web/src/components/session-detail.tsx` — pass `supported={session.supportsInteraction}` to banner; wire `onRespond`
- `apps/web/src/components/pending-user-input-banner.tsx` — `onRespond` calls the API, handles `501` with a toast
- `README.md` — add the new `POST .../respond` endpoint to the API table + document the contract
- `AGENTS.md` — new section "Interactive tools (AskQuestion)" under Architecture: contract, current `@cursor/sdk` limitation, future ACP path
- `.changeset/*.md` — single release note covering the whole PR (historical display + interface stub)

**Create:**
- `apps/server/test/unit/sessions/sessions.interaction.spec.ts` — `respondInteraction` returns `501` for Cursor/Pi; `supportsInteraction` resolves correctly
- Extend `apps/server/test/unit/agents/agents.registry.spec.ts` — `supportsInteraction()` for known + unknown providers
- Extend `apps/server/test/unit/app.spec.ts` — `POST :id/interactions/:requestId/respond` returns `501` for a cursor session

**Delete:** none.

## Implementation steps (TDD-first)

1. **Red — `agents.registry.spec.ts`:** `supportsInteraction('cursor')` → `false`; `supportsInteraction('pi')` → `false`; unknown provider → `false`; a stub provider with `supportsInteraction: () => true` → `true`.
2. **Green — `agents.types.ts` + `agents.registry.ts`:** add the optional methods + the registry resolver.
3. **Red — `sessions.interaction.spec.ts`:**
   - `respondInteraction(cursorSessionId, ...)` → throws `501`-equivalent (`NotImplementedException`)
   - `respondInteraction(piSessionId, ...)` → throws `501`
   - `supportsInteraction(cursorSessionId)` → `false`
   - A stub provider with `submitInteraction` implemented → `respondInteraction` calls it and returns `{ ok: true }`
4. **Green — `sessions.service.ts`:** implement `supportsInteraction` + `respondInteraction`.
5. **Red — `app.spec.ts`:** `POST /api/sessions/:id/interactions/:requestId/respond` on a cursor session → `501` with the documented error body.
6. **Green — `sessions.controller.ts`:** wire the route.
7. **Red+Green — `sessions.types.ts` + `sessions.repository.ts`:** add `supportsInteraction` to `SessionDto` and populate it in the service layer (not the repo — the repo doesn't know about the registry).
8. **Frontend wiring:**
   - `api.ts`: add `Session.supportsInteraction`, `respondInteraction()`, `InteractionApiError`
   - `session-detail.tsx`: pass `supported={session.supportsInteraction}`; `onRespond` calls `respondInteraction`, on `501` shows toast via `sonner`
   - `pending-user-input-banner.tsx`: `onRespond` prop is now callable; update spec to assert the toast on `501`
9. **Docs:**
   - `README.md` API table: `POST /api/sessions/:id/interactions/:requestId/respond` with note "501 for providers without live respond support"
   - `AGENTS.md`: new section documenting the contract, the `@cursor/sdk` limitation (no AskQuestion in `onDelta` public schema, no respond API), the ACP future path, and the `AWAITING_INPUT` FSM deferral
10. **Changeset:**
    ```bash
    bun run add-changeset patch "Imported Cursor chats now render AskQuestion tool calls as structured questionnaire blocks (title, questions, options, recorded answers) instead of a generic tool row. Live answering from the phone is not yet supported for the Cursor provider."
    ```
11. **Verify:**
    - `bun run check-changeset` passes
    - `bun run test` (server unit) green
    - `bun run --filter @nuncio/web test` green
    - `bun run build` green
    - `bun run lint` green
12. **Code review pass** (code-reviewer agent or Bugbot). Fix blockers; document warnings in the PR body.

## Todo List

- [ ] Write `agents.registry.spec.ts` cases (red)
- [ ] Add optional methods to `agents.types.ts` + `agents.registry.ts` (green)
- [ ] Write `sessions.interaction.spec.ts` (red)
- [ ] Implement `sessions.service.ts` `supportsInteraction` + `respondInteraction` (green)
- [ ] Write `app.spec.ts` HTTP case (red)
- [ ] Wire controller route (green)
- [ ] Add `supportsInteraction` to `SessionDto` + service-layer mapping
- [ ] Frontend: `api.ts` + `session-detail.tsx` + banner wiring
- [ ] Update `README.md` API table
- [ ] Update `AGENTS.md` interactive tools section
- [ ] `bun run add-changeset patch "..."` + commit fragment
- [ ] `bun run check-changeset` passes
- [ ] Full suite green: `bun run test`, `bun run --filter @nuncio/web test`, `bun run build`, `bun run lint`
- [ ] Code review pass

## Success Criteria

- `AgentProvider` interface has optional `supportsInteraction` + `submitInteraction`; Cursor and Pi providers omit them (default `false`)
- `POST /api/sessions/:id/interactions/:requestId/respond` returns `501` for Cursor and Pi sessions today
- `SessionDto.supportsInteraction` is `false` for all current providers
- `PendingUserInputBanner` renders with `supported={false}` for all current sessions → submit button disabled with tooltip; if a user somehow triggers `onRespond`, toast shows "not yet supported"
- `README.md` documents the new endpoint + contract
- `AGENTS.md` documents the `@cursor/sdk` limitation and the future ACP path
- Changeset is `patch` with a user-perspective release note; `bun run check-changeset` passes
- All tests + build + lint green
- Code review pass complete

## Risk Assessment

- **Adding a field to `SessionDto` breaks e2e fixtures:** the e2e test (`app.e2e-spec.ts`) may have hardcoded session JSON — check and update. Low risk, mechanical.
- **`501` vs `503` semantics:** `501 Not Implemented` is correct (the provider genuinely doesn't implement it). `503` would imply temporary. Documented in the controller comment.
- **Changeset bump challenge:** a reviewer might argue `minor` because "new API endpoint". Counter: the endpoint returns `501` for all providers today — no new user capability lands. The user-visible change is the historical display (Phase 1), which is polish. Document this reasoning in the PR body.

## Security Considerations

- New endpoint reuses existing session-resolution + auth (Tailscale network layer). No new auth surface.
- `respondInteraction` validates the session exists and the provider supports interaction before delegating. A future implementation must also validate the `requestId` matches an open pending in the event log (tracked as a TODO in the service).
- No secrets in the new payload; `truncatePayload` applies to answers (4KB cap).

## Next Steps

- **Future plan: ACP integration** — port Synara's `cursor/ask_question` handler into a new `CursorAcpProvider` (alongside the existing `@cursor/sdk` provider). Unblocks live respond without waiting for the SDK to expose AskQuestion in `onDelta`. When this ships, the historical display path (Phases 0+1) stays as-is (answers are the next `user_message`); the live path uses `POST .../respond` with answers stored inline in `user_input_resolved`. Large refactor — separate plan.
- **Future plan: `AWAITING_INPUT` FSM state** — once live respond ships, promote pending from derived projection to first-class session status. Enables push notifications and clean "skip" semantics.
- **Future plan: Approval flows** — `approval_requested` / `approval_resolved` events + `autoReview` bridge, reusing the same composer banner precedence pattern.
- **Future plan: Pi `ctx.ui.*` bridge** — map Pi extension UI to the same `user_input_*` contract; flip `supportsInteraction` to `true` for Pi.
