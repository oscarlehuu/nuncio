# MCP Store — Phase 1 plan

Context: [brainstorm.md](./brainstorm.md) (v3, decisions locked). This phase ships the registry +
import + bridge with the lazy meta-tool gateway, reaching all four engines through the existing
`AgentToolRegistry` tool-source lane. OAuth is phase 2; per-session picker phase 3; Codex
inherited-server suppression phase 4 (deferred by decision).

## Status — phase 1 SHIPPED (PR #126)

- [x] Worktree `cursor/mcp-store-dcb0` from `origin/dev`
- [x] Backend: schema + repository (secret values encrypted unconditionally; decrypt failures degrade to '' instead of poisoning `list()`)
- [x] Backend: registry service (scope resolution, masking, declassification guard, identity conflicts → 409)
- [x] Backend: import scanners (cursor/claude/codex, global + project, dedupe, env-derived headers force-flagged secret)
- [x] Backend: client pool (lazy connect via `call()`, in-flight-safe idle sweep, failing call retires only its own entry)
- [x] Backend: bridge tool source (inventory + `nuncio_mcp_find_tools` / `nuncio_mcp_call`, full-mode cache keyed on `updatedAt`, forSession failure containment)
- [x] Backend: `/api/mcp-servers` controller + module wiring (import preview masked)
- [x] Frontend: Settings → MCP & Tools rows (list / import preview→apply / toggle / advertise / delete)
- [x] e2e: real SDK client ↔ fixture stdio server (`test:e2e`)
- [x] Docs (README, AGENTS.md layout, product-surfaces, system-architecture) + changeset (minor)
- [x] `bun run gate` + `gate:full` green, independent review pass (1 blocker + 5 warnings found → fixed with regression specs), PR #126 → dev

Known deferrals from review (accepted): cross-store env-config differences are silently dropped on
provenance merge (identity ignores env by design); import resolves Codex `env_http_headers` at scan
time rather than connect time.

## Architecture recap

- New domain module `apps/server/src/mcp/` (NOT `mcp-stdio/`, which is the inverse product).
- `mcp_servers` SQLite table via guarded `CREATE TABLE` in `DatabaseService.migrate()`.
- Secrets (env/header values) encrypted with the existing settings AES-256-GCM key
  (`SETTINGS_KEY` — exported from `SettingsModule`).
- `McpBridgeToolSource` registers into `AgentToolRegistry` (same pattern as
  `CrewRuntimeToolsService.onModuleInit`), so Pi/Claude/Codex/Cursor all receive the gateway tools
  through their existing runtime-tools adapters.
- `AgentRuntimeToolScope` gains optional `workspace` (additive) so `${workspace}` placeholders
  resolve to the session worktree/cwd; `SessionsService` passes it where it builds tool scope.
- Client pool: `@modelcontextprotocol/sdk@1.x` behind an injectable `McpClientFactory` (unit tests
  use fakes; e2e uses the real factory against a fixture stdio server). Identity = resolved
  transport hash. Lazy connect on first `find_tools`/`call`; idle sweep disposes unused clients.
- Full-advertise mode uses a warm schema cache (async warm-up on boot/create/update); when the
  cache is cold the server is still fully usable via the lazy gateway.

## File map

```
apps/server/src/mcp/
  domain/mcp.types.ts                  # McpServerDefinition/Dto, transports, rows
  domain/mcp-transport.ts              # identity hash, ${workspace} resolution, secret-key heuristic
  persistence/mcp-servers.repository.ts
  import/mcp-import.types.ts
  import/cursor-mcp-scanner.ts         # ~/.cursor/mcp.json + <proj>/.cursor/mcp.json
  import/claude-mcp-scanner.ts         # ~/.claude.json (global + projects map) + <proj>/.mcp.json
  import/codex-mcp-scanner.ts          # ~/.codex/config.toml + <proj>/.codex/config.toml (Bun.TOML)
  import/mcp-import.service.ts         # scan → dedupe → preview/apply
  bridge/mcp-client.types.ts           # McpBridgeClient + McpClientFactory
  bridge/mcp-client-pool.ts
  bridge/mcp-client.factory.ts         # real @modelcontextprotocol/sdk factory
  bridge/mcp-bridge.tool-source.ts
  api/mcp-servers.controller.ts
  mcp.service.ts
  mcp.module.ts
apps/server/test/unit/mcp/*.spec.ts    # repository, service, import (fixtures), pool, bridge, controller
apps/server/test/e2e/mcp-bridge.e2e-spec.ts + fixture server
apps/web/src/components/settings/…     # MCP & Tools section rows (mirror existing settings rows)
```

## Contracts

- Gateway tools (stable, ~constant token cost):
  - `nuncio_mcp_find_tools({ query?, server? })` → tools with name/description/full inputSchema
  - `nuncio_mcp_call({ server, tool, args? })` → mapped `AgentRuntimeToolResult`
- Tool security metadata: `network: 'required'` → Crew (network-disabled) sessions excluded for
  free by the existing policy gate.
- API: `GET/POST /api/mcp-servers`, `PUT/DELETE /api/mcp-servers/:id`,
  `POST /api/mcp-servers/import` (`{ source, dryRun? }`), masked secrets everywhere.

## TDD spec list (write red first)

1. repository: CRUD; identity-dedupe upsert merges `sources`; env/header secrets stored as `v1:`
   ciphertext, decrypted on read-for-runtime, masked on DTO
2. service: resolveForSession — global + project scope (path normalization), engines filter,
   disabled excluded; worktree sessions match on projectPath
3. import: per-format fixtures (JSON ×2, TOML) incl. project-scoped files; cross-source dedupe
   (`bridgememory` ×3 → 1 row, 3 sources); secret-env detection; dryRun preview
   (new/existing/changed); idempotent re-import
4. pool: factory not called until first use; one client per identity reused; idle disposal; factory
   failure → isError result, next call retries; dispose-all on destroy
5. bridge: undefined when no servers resolve; inventory lines in systemPromptAppend; find_tools
   lazily connects + filters; call routes + maps content; unknown server/tool errors; full-mode
   cached schemas advertised as `<server>_<tool>`; `${workspace}` resolution; security metadata
6. controller: masking, validation, import dryRun/apply
7. e2e: fixture stdio MCP server (SDK server API) round-trip through real factory + pool + bridge
