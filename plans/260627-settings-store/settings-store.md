# Plan: Settings store (DB-backed env config + frontend)

**Started:** 2026-06-27
**Status:** Complete — 295 tests green (182 server unit + 14 e2e + 99 web), lint + build clean

## Goal

Move runtime-configurable env vars out of `process.env` into a DB-backed settings store, configurable via frontend. Boot-only vars (`NUNCIO_DATA_DIR`, `PORT`) stay env-only. Secrets encrypted at rest.

## Decisions (locked)

1. **Scope:** All env vars except boot-only (`NUNCIO_DATA_DIR`, `PORT`). Includes paths (`NUNCIO_PROJECT_ROOTS`, `NUNCIO_WORKSPACES_DIR`, `PI_AGENT_DIR`), credentials (`CURSOR_API_KEY`), behavioral flags (`NUNCIO_FORCE_MOCK`, `NUNCIO_CURSOR_CWD`).
2. **Pi credentials:** Read-only status on frontend (Pi auth lives in `~/.pi/agent/auth.json`, shared with `pi` CLI). Frontend shows "configured: yes/no".
3. **Encryption:** Encrypt secret-typed values at rest with AES-256-GCM. Key from `NUNCIO_SETTINGS_KEY` (boot-only env, 32-byte hex/base64). If absent, generate + persist a per-install key file at `data/settings.key` (mode 0600) and warn in logs.

## Architecture

### Resolution order (back-compat)
`SettingsService.resolve(key)`:
1. DB `settings` table (DB wins)
2. `process.env[envVar]` (env still works)
3. `definition.default`

### Cache invalidation
`SettingsService.set()` → emit `settings.changed` → `AgentRegistry.bustCaches()` clears `cachedAvailable`/`cachedModels` on all providers.

### Secret masking in API
`GET /api/settings` returns `{ hasValue, valueMasked }` for secrets (never raw value). Non-secrets return raw value.

## File layout

```
apps/server/src/settings/
  settings.types.ts                  # SettingDefinition, SettingDto
  settings.registry.ts               # SETTING_DEFINITIONS (declarative catalog)
  settings.crypto.ts                 # AES-GCM encrypt/decrypt + key load
  persistence/settings.repository.ts # CRUD on settings table
  settings.service.ts                # resolve/set/list/delete + onChange
  api/settings.controller.ts         # REST with secret masking
  settings.module.ts
apps/server/test/unit/settings/
  settings.crypto.spec.ts
  settings.repository.spec.ts
  settings.service.spec.ts
  settings.controller.spec.ts
```

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | DB schema + migration (settings table) | done |
| 2 | settings.types + registry (catalog) | done |
| 3 | Encryption layer (AES-GCM) — TDD | done |
| 4 | SettingsRepository — TDD | done |
| 5 | SettingsService (resolve + onChange) — TDD | done |
| 6 | SettingsController (secret masking) — TDD | done |
| 7 | Wire AgentRegistry.bustCaches() + SettingsService onChange | done |
| 8 | Refactor CursorAgentProvider → SettingsService.resolve() | done |
| 9 | Refactor GitService → SettingsService.resolve() | done |
| 10 | Refactor PiAgentProvider FORCE_MOCK + PI_AGENT_DIR + bustCache | done |
| 11 | Frontend Settings page + API client — TDD | done |
| 12 | Full test + lint + build green | done |
| 13 | Docs: README + AGENTS.md env table + settings API | done |

## Schema

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,           -- encrypted for type='secret', plain otherwise
  updated_at INTEGER NOT NULL
);
```

## API

```
GET    /api/settings              → list with metadata + hasValue (+ valueMasked for secrets)
GET    /api/settings/:key         → single
PUT    /api/settings/:key         → { value } (DB overrides env from this point)
DELETE /api/settings/:key         → clear DB row, fallback to env/default
```

## Success criteria

- All existing env vars still work unchanged (back-compat).
- `bun run test` + `bun run test:e2e` + `bun run --filter @nuncio/web test` green.
- `bun run lint` + `bun run build` green.
- Secret values never appear in any GET response.
- Changing `CURSOR_API_KEY` via API flips `cursor` provider availability without restart.
