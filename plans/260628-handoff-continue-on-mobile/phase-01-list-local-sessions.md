# Phase 01 — List Local Cursor Sessions

**Priority:** P1
**Status:** Not started
**Depends on:** Phase 0 spike (path contract locked)
**Estimated:** 1 day
**Lane:** A (backend)

## Context Links

- [Plan overview](./plan.md)
- [Phase 0 findings](./spike-findings.md) (paths + slug rules)
- Existing pattern: `apps/server/src/fs/fs.service.ts` (host directory browser) + `fs.controller.ts`

## Overview

Read-only API that scans `~/.cursor/projects/*/agent-transcripts/*/` and returns recent in-progress chats for a given workspace. Powers the phone picker in Phase 5. **No import, no mutation, no CLI spawn.**

## Key insights

- Transcripts live at `~/.cursor/projects/<project-slug>/agent-transcripts/<chatId>/<chatId>.jsonl` (one JSON line per message turn).
- `project-slug` is derived from the absolute workspace path (e.g. `/Users/a1241968/Desktop/Oscar/nuncio` → `Users-a1241968-Desktop-Oscar-nuncio`). Exact rule to be locked in Phase 0.
- Title = first `role: user` message text, truncated to ~80 chars, stripped of `<user_query>` wrappers.
- `updatedAt` = file mtime. Sort desc.
- `alreadyImported` requires a DB lookup against `sessions.cursor_chat_id` (Phase 2 adds the column; until then, return `false`).

## Requirements

### Functional
- `GET /api/cursor/local-sessions?workspace=<absPath>` returns chats for that workspace only.
- Each item includes: `chatId`, `workspace`, `projectSlug`, `title`, `preview`, `updatedAt`, `messageCount`, `alreadyImported`, `nuncioSessionId?`.
- Filter out empty transcripts (0 lines) and subagent-only folders.
- Limit to 20 most recent by default; `?limit=` override (max 50).

### Non-functional
- Must not spawn any subprocess.
- Must not read `store.db` files (SQLite) — JSONL is enough for the list.
- Response time < 200ms for a workspace with ~50 transcripts.
- Never expose absolute paths of other workspaces (only the requested one).

## Architecture

New domain module `cursor-local` (sibling to `fs`, `git`, `settings`):

```
apps/server/src/cursor-local/
  cursor-local.module.ts
  cursor-local.controller.ts        # GET /api/cursor/local-sessions
  cursor-local-sessions.service.ts  # scan + parse
  cursor-local-sessions.types.ts    # DTOs
  cursor-transcript.parser.ts       # pure: parse JSONL line → structured turn (used again in Phase 4)
```

Controller is thin; service does the scan. Parser is pure and unit-testable — Phase 4 reuses it for hydration.

`CursorLocalSessionsService` depends on `SessionsRepository` (for `alreadyImported` lookup once Phase 2 lands; until then, a stub returning `false`).

## Related code files

**Create:**
- `apps/server/src/cursor-local/cursor-local.module.ts`
- `apps/server/src/cursor-local/cursor-local.controller.ts`
- `apps/server/src/cursor-local/cursor-local-sessions.service.ts`
- `apps/server/src/cursor-local/cursor-local-sessions.types.ts`
- `apps/server/src/cursor-local/cursor-transcript.parser.ts`
- `apps/server/test/unit/cursor-local/cursor-local-sessions.service.spec.ts`
- `apps/server/test/unit/cursor-local/cursor-transcript.parser.spec.ts`
- `apps/server/test/unit/cursor-local/cursor-local.controller.spec.ts`

**Modify:**
- `apps/server/src/app.module.ts` — import `CursorLocalModule`

**Delete:** none.

## Implementation steps

1. Write `cursor-transcript.parser.spec.ts` first (TDD): feed fixture JSONL lines → assert structured `{role, text, toolUses?, timestamp?}` per turn. Cover: user message, assistant text, assistant tool_use, malformed line (skip), `<user_query>` wrapper strip.
2. Implement `cursor-transcript.parser.ts` to pass.
3. Write `cursor-local-sessions.service.spec.ts`: point service at a fixture dir with 3 transcripts (varied mtimes, one empty, one subagent-only) → assert sorted list, filtering, title extraction, message count.
4. Implement `cursor-local-sessions.service.ts`:
   - Resolve `~/.cursor/projects/<slug>/agent-transcripts/`
   - Read each `<chatId>/<chatId>.jsonl` lazily (first line for title, last assistant line for preview, line count for `messageCount`)
   - Sort by mtime desc
5. Write `cursor-local.controller.spec.ts`: query param parsing, missing workspace → 400, limit clamp.
6. Implement controller + module; wire into `app.module.ts`.
7. Run `bun run --filter @nuncio/server test` → green.

## Todo

- [ ] TDD parser spec + impl
- [ ] TDD service spec + impl (fixture-based)
- [ ] TDD controller spec + impl
- [ ] Wire `CursorLocalModule` into `app.module.ts`
- [ ] `bun run test` green
- [ ] `bun run lint` green

## Success criteria

- `GET /api/cursor/local-sessions?workspace=/Users/a1241968/Desktop/Oscar/nuncio` returns the real transcripts on this Mac, sorted by recency, with correct titles.
- Empty / subagent-only folders excluded.
- Unit tests cover: title extraction, preview, sort, filtering, limit, missing workspace, malformed lines.
- No subprocess spawned (verify with a test that stubs `child_process`).

## Risk assessment

| Risk | Mitigation |
|------|------------|
| `project-slug` rule wrong | Phase 0 locks it; service uses a single `toProjectSlug(absPath)` helper that's unit-tested |
| Huge transcripts slow the list | Only read first + last line + count; never full-parse for list |
| Permission errors reading `~/.cursor` | Catch + skip; log warning; don't 500 the whole list |

## Security considerations

- Endpoint is read-only and scoped to the requested workspace.
- Do not return transcripts from other workspaces even if they share a slug prefix.
- Strip `<user_query>` and any attached skill/context blobs from `title` so the picker doesn't leak internal prompt scaffolding.
- No secret values in transcripts (Cursor doesn't store API keys in JSONL) but defend in depth: never log full transcript lines.

## Next steps

- Phase 2 adds the DB column + `alreadyImported` wiring.
- Phase 4 reuses `cursor-transcript.parser.ts` for hydration.
