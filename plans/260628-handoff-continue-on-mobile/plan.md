# Plan — Handoff: Continue on Mobile (selective import)

**Started:** 2026-06-28
**Status:** Shipped on branch `cursor/handoff-continue-on-mobile`
**Branch:** `cursor/handoff-continue-on-mobile`

## Goal

Let a user mid-task in Cursor (IDE or CLI) on their Mac pick **one** in-progress chat and continue it from the Nuncio phone PWA — **without losing conversation context or agent checkpoint state**. Selective import only; no auto-sync of all chats.

## Core decision (locked)

- **Session created on Nuncio** → keeps using **`@cursor/sdk` in-process** (low latency, concurrent). Unchanged.
- **Session imported from Cursor IDE/CLI** → uses **`cursor` CLI subprocess** (`agent -p --resume <chatId>`) because the SDK cannot resume IDE/CLI chats (different store).
- **One Nuncio session ↔ one backend** (`sdk` or `cli`). No cross-backend fallback. Backend chosen at create/import time, stored on the session row, never changes.
- **No auto-import.** User picks a session from a picker; only that one is imported.

## Phases

| Phase | Focus | Effort | Plan |
|-------|-------|--------|------|
| 0 | Spike — validate CLI resume + ID/path contract | 0.5d | [phase-00-spike-validation.md](./phase-00-spike-validation.md) |
| 1 | `GET /api/cursor/local-sessions` — read-only list for picker | 1d | [phase-01-list-local-sessions.md](./phase-01-list-local-sessions.md) |
| 2 | `POST /api/sessions/handoff` — import selected session + DB migration | 1d | [phase-02-handoff-import.md](./phase-02-handoff-import.md) |
| 3 | `CursorCliProvider` — spawn CLI, parse `stream-json` → events | 1.5d | [phase-03-cursor-cli-provider.md](./phase-03-cursor-cli-provider.md) |
| 4 | Transcript hydration — replay old chat into event log | 1d | [phase-04-transcript-hydration.md](./phase-04-transcript-hydration.md) |
| 5 | UI — "Continue on Mac" picker + import flow on phone | 1.5d | [phase-05-ui-continue-on-mobile.md](./phase-05-ui-continue-on-mobile.md) |
| 6 | Hardening, dedupe, error UX, docs, changeset, ship | 1d | [phase-06-hardening-ship.md](./phase-06-hardening-ship.md) |

**Total:** ~7.5d sequential. Phases 1+2 can parallelize (different files). Phase 4 can follow 2 in parallel with 3. Phase 5 can mock against Phase 1's API shape before 3 lands.

## Dependency graph

```
P0 ──► P1 ──► P2 ──► P3 ──► P5 ──► P6
                └► P4 ──^
```

- P0 gates everything (risk: CLI resume assumptions).
- P1 + P2 share the `cursor-local` module; can be one PR.
- P3 and P4 both depend on P2's schema; independent of each other.
- P5 depends on P1 (list API) + P3 (steer works) + P4 (transcript visible).

## Lane ownership (per phase)

| Lane | Ownership |
|------|-----------|
| A — Backend | `apps/server/src/**` (except `*.spec.ts`) |
| B — Frontend | `apps/web/src/**` |
| C — Tests + Docs | `*.spec.ts`, `apps/server/test/**`, `README.md`, `AGENTS.md`, `plans/reports/` |

Strict file ownership — no overlapping edits. Tests own test files only; read implementation, never edit.

## Key paths (verified on this Mac, 2026-06-28)

- CLI binary: `~/.local/bin/agent` (v2026.06.19)
- IDE/CLI transcripts: `~/.cursor/projects/<project-slug>/agent-transcripts/<chatId>/<chatId>.jsonl`
- CLI chat store: `~/.cursor/chats/<workspace-hash>/<chatId>/{meta.json,store.db}`
- SDK store (Nuncio): `apps/server/data/cursor-store/*.ndjson`
- Resume command (verified working):
  ```bash
  agent -p --trust --force --workspace <absPath> --resume <chatId> \
    --output-format stream-json --stream-partial-output "<steer>"
  ```

## Non-goals (this plan)

- Auto-sync / mirror all Cursor chats.
- Bidirectional handoff (Nuncio → Cursor IDE).
- Importing Composer chat tabs that have no transcript folder.
- Replacing the SDK provider for Nuncio-created sessions.
- Multi-agent / sub-agent replay (subagent JSONL exists but out of scope).

## Next steps (future roadmap)

- **Multi-select import** — picker lets user pick N chats, import all in one call
- **Two-way sync** — Mac Cursor + Nuncio both update same transcript (conflict resolution needed)
- **Cloud agent handoff** — `bc-` IDs via SDK `Agent.resume` (different store from local CLI)
- **Subagent replay** — hydrate `~/.cursor/projects/<slug>/agent-transcripts/<chatId>/subagents/` JSONL
- **Nuncio → Cursor IDE** — open a Nuncio session back in Cursor desktop ("Open on Mac")
- **Cursor IDE extension** — button inside Cursor to push chat to Nuncio
