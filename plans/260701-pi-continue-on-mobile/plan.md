# Plan — Pi Handoff: Continue on Mobile (in-process, no subprocess)

**Started:** 2026-07-01
**Status:** Planned
**Depends on:** existing Cursor handoff subsystem (mirrors its shape)

## Goal

Let a user mid-task in the **pi CLI** on their Mac pick one in-progress pi session
and continue it from the Nuncio phone PWA — same conversation, same checkpoint,
without losing context. Selective import only; no auto-sync.

Concretely: work on pi CLI at the desk → walk out → keep going from the cafe on the phone.

## Why this is smoother than the Cursor path

The Cursor handoff must spawn `agent` as a subprocess and parse `stream-json` off
stdout, **because the Cursor SDK cannot resume IDE/CLI chats** (separate store).

Pi has no such limitation. The pi **SDK** reads the *same* JSONL store the pi CLI
writes: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`.

- `SessionManager.list(cwd)` / `.listAll()` → discovery (verified: returns 8 sessions
  for this repo, top one is a live CLI chat).
- `SessionManager.open(path)` → resume. **`PiAgentProvider.createPiSession`
  already does this** (`apps/server/src/agents/providers/pi-agent.provider.ts:229`)
  when `providerThreadId` is set, then streams via `session.subscribe`.

So the *continue* side needs **zero new provider code**: in-process, native token
streaming, concurrent — identical to a fresh Nuncio pi session.

| | Cursor CLI handoff | Pi handoff (this plan) |
|---|---|---|
| Transport | spawn subprocess | in-process SDK |
| Streaming | reparse `stream-json` | `session.subscribe` (built) |
| Resume | `agent --resume` | `SessionManager.open` (built) |
| New provider code | yes | **none** |

## Core decisions (locked)

- **Resume in place** — Nuncio opens the *same* session file (single continuous
  session), consistent with "nothing mix": one session, one file.
- **No guards, no dialogs** — import always succeeds silently. The composer just
  reflects live state: if the pi agent is mid-turn, the send button becomes
  steer/stop (a new message steers); if idle, normal send. Same behavior a live
  Nuncio session already has. (No `assertNotRecentlyActive` equivalent.)
- **Dedup key = `providerThreadId`** — it already stores the pi session file path
  (`session.sessionFile`), unique per session and exactly what resume needs.
  Add `findByProviderThreadId()`. **No migration, no Cursor-column overload.**
- **`provider: 'pi'`, `cursorBackend: null`** — routes through the existing pi
  SDK provider via `agents.registry.ts:54` (`cursorBackend === 'cli'` stays false,
  so it falls through to `get(session.provider)` = pi). No routing change needed.

## Pi transcript shape (verified on this Mac)

Entry lines are `{type:"message", message:{role, content:[...]}}` plus
`model_change` / `thinking_level_change` / `session` / `session_info`.

| role | content block | → Nuncio event |
|------|---------------|----------------|
| `user` | `text` | `user_message` |
| `assistant` | `thinking` | skip |
| `assistant` | `text` | `assistant_message` |
| `assistant` | `toolCall` (`id`,`name`,`arguments`) | `tool_start` |
| `toolResult` | `text` | `tool_end` |

Note: pi uses `toolCall` + role `toolResult` (NOT Cursor's `tool_use`/`tool_result`),
so hydration needs a pi-specific mapper. Prefer building it off the SDK's parsed
`SessionManager.open(path).getEntries()` rather than hand-parsing JSONL.

## Phases

| Phase | Focus | Lane | Files |
|-------|-------|------|-------|
| 1 | `PiLocalSessionsService` — list/read via `SessionManager` | A backend | `apps/server/src/pi-local/**` (new) |
| 2 | Generalize `handoff()` + `createHandoff()` for pi backend; `findByProviderThreadId()` | A backend | `sessions.service.ts`, `sessions.repository.ts`, `sessions.controller.ts`, `sessions.types.ts` |
| 3 | Pi transcript hydration (`getEntries()` → events); wire into `hydrateIfNeeded`/`refreshTranscriptIfNeeded` | A backend | `apps/server/src/pi-local/pi-transcript-hydrate.ts` (new), `sessions.service.ts` |
| 4 | `GET /api/pi/local-sessions` endpoint + module | A backend | `pi-local.controller.ts`, `pi-local.module.ts` (new) |
| 5 | UI — extend "Continue on mobile" picker with a pi source (or unified list) | B frontend | `handoff-picker.tsx`, `handoff-api.ts`, `App.tsx` |
| 6 | Tests, dedupe, changeset, docs | C tests/docs | `*.spec.ts`, `README.md`, `AGENTS.md`, `plans/reports/` |

## API shape

`GET /api/pi/local-sessions?workspace=<abs>` →
```
{ items: [{ sessionId, path, workspace, title, preview, updatedAt, messageCount,
            alreadyImported, nuncioSessionId? }] }
```
`POST /api/sessions/handoff` extended to accept `{ piSessionPath, workspace, title? }`
alongside the existing Cursor `{ cursorChatId, workspace, title? }` (discriminated).

## Non-goals

- Auto-sync / mirror all pi sessions.
- Nuncio → pi CLI reverse handoff.
- Fork-on-import (explicitly rejected: resume-in-place chosen).
- Collision guards / "still running" prompts (explicitly rejected: silent, composer adapts).
- Cross-cwd fork (`SessionManager.forkFrom` exists but out of scope).

## Open verification during build

- Confirm `SessionManager.list` cwd encoding matches Nuncio's worktree cwd when a
  session was created in a worktree (pi encodes real cwd into the dir name).
- Confirm steering a resumed CLI session while the desk CLI is idle appends cleanly
  (append-only tree; leaf advances) — the "nothing mix" happy path.
