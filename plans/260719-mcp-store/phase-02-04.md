# MCP Store — Phases 2–4

Phase 1 shipped (PR #126). **Phases 2–4 implemented** on `cursor/mcp-store-dcb0`.

## Phase 2 — Nuncio-side OAuth ✅

- Table `mcp_oauth` (server_id PK): encrypted tokens/client_info/code_verifier, state, redirect_uri, updated_at
- `NuncioOAuthProvider` implements SDK `OAuthClientProvider` (1.29)
- `McpOAuthService.start(serverId, redirectOrigin)` → authorizationUrl
- `GET /api/mcp/oauth/callback` `@Public()` validates state → `transport.finishAuth(code)`
- Factory passes `authProvider` for `auth: 'oauth'` remotes; unauthed servers show "auth required" in inventory
- Settings UI: Connect/Reconnect pill on oauth rows
- TDD: oauth repo encrypt, start creates state, callback finishes, bridge marks unauthed

## Phase 3 — Per-session picker + project defaults ✅

- `sessions.mcp_server_ids_json` + `projects.mcp_server_ids_json`
- `CreateSessionDto.mcpServerIds?` + controller whitelist
- `McpService.resolveForSession({ ..., mcpServerIds?, projectDefaults? })`:
  session override → project default → all enabled scoped (current)
- Frontend: chip picker on home composer; projects settings multi-select
- TDD: resolution precedence, create persistence, UI picker

## Phase 4 — Codex inherited-server suppression ✅

- Scan `~/.codex/config.toml` (+ project) for mcp_servers names
- On `thread/start` + `thread/resume`, pass `config.mcp_servers: { [name]: { enabled: false } }` for every inherited name **not** in the session's resolved Nuncio MCP set (so bridge-owned servers aren't double-loaded via native inherit)
- Inject via `AgentRunContext` optional `codexMcpConfig?` or a small helper the Codex provider calls
- TDD: suppress list construction + thread/start params include config
