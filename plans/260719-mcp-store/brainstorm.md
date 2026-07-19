# MCP Store — brainstorm (v3, decisions locked)

> Goal: one Nuncio-owned MCP registry aggregating the Codex / Claude Code / Cursor stores, where
> **any imported server runs on any engine — including Nuncio Engine (Pi)** — with **project-scoped**
> attachment, not just global.

## Decisions log (user, 2026-07-19)

1. **Token cost → lazy loading.** Servers may default off, but the preferred answer is lazy
   loading. → Adopted: **lazy meta-tool gateway is the default advertise mode** (§4). Token cost
   per enabled server ≈ one inventory line, so servers can default to *enabled + lazy*.
2. **Codex double-load (bridge + inherited config.toml): accepted temporarily.** Suppression is
   deferred to a later phase.
3. **OAuth: Nuncio-side, in the bridge.** Don't wait for Codex-native delivery. → Phase 2 (§6).

## 0. Ground truth on this machine (2026-07-19)

| Source store | Global file | Project file | Servers found (global) |
|---|---|---|---|
| Cursor | `~/.cursor/mcp.json` | `<proj>/.cursor/mcp.json` | 3 stdio: `ios-simulator`, `XcodeBuildMCP`, `bridgememory` |
| Claude Code | `~/.claude.json` `mcpServers` | `<proj>/.mcp.json` + `~/.claude.json` `projects.<path>.mcpServers` | 1 stdio: `bridgememory` (50 projects tracked, 0 project-scoped) |
| Codex | `~/.codex/config.toml` `[mcp_servers.*]` | `<proj>/.codex/config.toml` (trusted projects only) | ~13 mixed: stdio (`hermes-tools`, `playwright`, `ios-simulator`, `node_repl`, `bridgememory`, `computer-use`) + http (`figma`, `gitnexus`, `stripe`, `box`, `supabase`, `openaiDeveloperDocs`, `revenuecat`) |

Shaping observations: heavy overlap (`bridgememory` ×3) → dedupe on transport identity; Nuncio
Codex sessions already inherit all ~13 servers via shared `CODEX_HOME` (double-load accepted for
now); Claude sessions currently get zero external MCP (`settingSources: []`); secrets in `env`
blocks → encrypt on import (`settings.crypto` AES-256-GCM exists).

## 1. Architecture: bridge-first

"Any store's server on any engine" + Pi (no SDK MCP support, "No MCP" philosophy) forces a
**Nuncio-hosted MCP client pool**. The seam already exists: `AgentToolRegistry.registerSource()` +
`AgentRuntimeToolSource.forSession({ sessionId, projectPath, provider, model })` — already
project-aware. One `McpBridgeToolSource` registered there reaches **all four engines** through
their existing adapters (Pi `customTools`, Claude `nuncio-runtime` sdk MCP, Codex `dynamicTools`,
Cursor `customTools`) with zero new per-engine plumbing.

Native pass-through (Claude `mcpServers`, Cursor `Agent.create({ mcpServers })`, Codex
`config.mcp_servers`) is now **backlog-only**: with OAuth handled Nuncio-side (§6), its remaining
value is engine-native niceties (`required`, deferLoading, `/mcp` inspection). Build only if a
concrete need appears.

Anti-confusion: `apps/server/src/mcp-stdio/` is the inverse product (Nuncio *as* MCP server).
Separate modules, separate docs ("Nuncio MCP" = outbound; "MCP Store/Bridge" = inbound).

## 2. Canonical schema (scope-aware)

```ts
interface McpServerDefinition {
  id: string;                  // slug, unique
  name: string;
  description?: string;        // feeds the lazy inventory line — keep it good
  transport:
    | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
    | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
  enabled: boolean;            // default true (lazy makes this cheap)
  advertise: 'lazy' | 'full';  // default 'lazy'; 'full' = classic per-tool schemas
  scope: 'global' | 'project';
  projectPath?: string;        // required when scope='project'; normalized absolute
  engines?: ('pi' | 'claude' | 'cursor' | 'codex')[]; // absent = all
  source: 'nuncio' | 'import:cursor' | 'import:claude' | 'import:codex';
  auth?: 'none' | 'oauth';     // oauth = Nuncio-side flow (§6)
  secretEnvKeys?: string[];    // env/header keys stored encrypted
}
```

- `${workspace}` placeholder in `command`/`args`/`cwd`/`env`, resolved per-session (worktree-aware).
- Storage: `mcp_servers` table (guarded `CREATE TABLE` in `DatabaseService`); OAuth tokens in a
  sibling `mcp_oauth` table, encrypted.

## 3. Resolution & attach

- Per session: enabled global rows + enabled project rows matching `session.projectPath`, filtered
  by `engines` vs `session.provider`. Worktree sessions match scope on `projectPath`, run with
  `${workspace}` = worktree cwd.
- Crew: excluded for free — bridge tools carry `security.network: 'required'`; the runtime-policy
  gate strips them from network-disabled sessions.

## 4. Lazy loading (the token answer)

**Default mode: meta-tool gateway.** Instead of advertising N×M tool schemas every turn, the bridge
advertises two compact Nuncio tools + a one-line-per-server inventory in `systemPromptAppend`:

- `nuncio_mcp_find_tools({ query?, server? })` → matching tools with name, description, and full
  input schema (connects to the server on first touch).
- `nuncio_mcp_call({ server, tool, args })` → executes and returns mapped content.

Properties:

- **Token cost is ~constant** regardless of how many servers are enabled (2 small schemas + K
  inventory lines). This is the pattern behind Anthropic's tool-search / code-execution-with-MCP
  writeups (order-of-magnitude schema-token reductions) and Codex's experimental
  `deferLoading` — but engine-neutral, so it works on Pi too.
- **Lazy processes, not just lazy tokens:** the pool doesn't spawn/connect a server until
  `find_tools`/`call` first touches it; inventory lines render from registry metadata alone.
  Idle servers shut down (ref-count + idle timer, mirroring the transcript-watcher pattern).
- **Trade-off:** one extra discovery hop before first use, and weaker affordance than native
  schemas — mitigated by good `description` lines in the inventory and full-schema results from
  `find_tools`.
- **Per-server override `advertise: 'full'`** for small high-frequency servers (e.g.
  `bridgememory`) where direct tool schemas are worth the tokens. Full-mode tools are named
  `<server>_<tool>` (collision-proof prefix).
- Stable advertised toolset (the 2 gateway tools) → no mid-session tool-set churn when the enabled
  server set changes; Claude's `setMcpServers` rebuild path stays for full-mode servers only.
- Approvals: on approval-gated engines, `nuncio_mcp_call` flows through the existing
  `canUseTool`/approval-card path; input (`server`, `tool`, `args`) is legible in the card.

**Default policy resolved:** with lazy as default, imported servers land *enabled + lazy* (global
or project scope as discovered). No default-off needed; disabling remains a per-row switch.

## 5. Bridge client pool

- One client per resolved definition (identity = transport after `${workspace}` resolution), shared
  across sessions/engines; lazy connect (§4); idle shutdown.
- Transports: stdio + streamable-http/sse (static headers) in phase 1; OAuth in phase 2.
- MCP text/image content → `AgentRuntimeToolResult` (both supported); other content stringified.
- Failure containment: a dead server yields an isError result for its calls + a transcript status
  event; never fails the session. `find_tools` reports unreachable servers explicitly.

## 6. Nuncio-side OAuth (phase 2 — user decision)

Grounded in MCP TS SDK v2 (`@modelcontextprotocol/client`): transports accept `authProvider:
OAuthClientProvider`; the SDK drives discovery (RFC 8414/9728), Client ID Metadata Documents,
Dynamic Client Registration (RFC 7591) fallback, PKCE, refresh, and `iss` validation. Nuncio
implements the storage/redirect surface:

- `NuncioOAuthProvider` per server row: tokens/clientInformation/codeVerifier/discoveryState
  persisted encrypted in `mcp_oauth`, keyed by issuer (SEP-2352 — never reuse a client_id across
  authorization servers).
- **Callback route** `GET /api/mcp/oauth/callback` → validate `state` (CSRF, maps callback → server
  row + pending flow), `transport.finishAuth(params)`, reconnect on a fresh transport.
- **Redirect URI** = the origin the login was initiated from (loopback on the Mac, Tailscale HTTPS
  from the phone) — captured per flow at initiation, so phone-initiated logins round-trip through
  the same Nuncio URL the phone can reach.
- **UI:** server rows with `auth: 'oauth'` show a Connect/Login pill (Source-Control row style);
  expired/invalid_grant flips the row to "reconnect" state with a toast; tools of an unauthed
  server stay listed in inventory with an "auth required" marker so the agent can tell the user.
- Import marks known-OAuth remotes (`figma`, `stripe`, `supabase`, …) as `auth: 'oauth'`
  (heuristic: Codex `rmcp_client`/login state, or first 401 with WWW-Authenticate at connect time).

## 7. Import model: copy-into-DB, never write back

- Read-only scanners per source: Cursor global+project `mcp.json`; Claude `~/.claude.json`
  (global + `projects` map) + `<proj>/.mcp.json`; Codex `~/.codex/config.toml` +
  `<proj>/.codex/config.toml`. Project scan covers `NUNCIO_PROJECT_ROOTS` repos + paths already
  used by sessions.
- Idempotent + refreshable (preview → confirm), dedupe by transport identity, multi-source
  provenance, secret-looking env/header values encrypted, masked via API.

## 8. Surfaces

- **API:** `GET/POST /api/mcp-servers`, `PUT/DELETE /api/mcp-servers/:id`,
  `POST /api/mcp-servers/import` (`{ source }` → preview → confirm),
  `POST /api/mcp-servers/:id/oauth/start`, `GET /api/mcp/oauth/callback`.
- **Settings UI:** existing "MCP & Tools" section — grouped rows (transport icon + name + subtitle:
  scope badge, engines, source, lazy/full, auth state) + Manage pill → editor; header "Import from
  Codex / Claude / Cursor".
- **Docs:** `product-surfaces.md`, `system-architecture.md`, disambiguation vs `nuncio-mcp.md`.

## 9. Phasing

1. **Registry + import + bridge with lazy gateway.** Table/repo/service/controller; 3 scanners
   (global + project); client pool (stdio + http static headers, lazy connect, idle shutdown);
   `McpBridgeToolSource` with `find_tools`/`call` + inventory; Settings UI. → All four engines,
   cross-store, project-scoped, ~zero marginal token cost.
   TDD: parser fixtures per format, dedupe, `${workspace}` resolution, scope resolution
   (global/project/worktree), lazy gateway (inventory render, find→call flow, unreachable server),
   pool ref-count/idle, tool-result mapping, secret masking, Crew exclusion.
2. **Nuncio-side OAuth** (§6): `NuncioOAuthProvider`, encrypted token store, callback route, UI
   Connect pill, re-auth on invalid_grant. Integration spec against a real OAuth MCP remote.
3. **Per-session picker** (chip beside model picker) + per-project default sets.
4. **Codex inherited-server suppression** (`enabled:false` patches on start+resume) — deferred by
   decision #2; ship when double-load starts to hurt.
5. *(Backlog, only on concrete need)* Native delivery mode per server for engine-native features.

## 10. Remaining open questions

- Inventory line budget: cap `systemPromptAppend` inventory (e.g. ~30 servers) with a "more via
  find_tools" tail, or always list all enabled servers?
- Should `advertise: 'full'` be settable per engine (e.g. full on Claude, lazy on Pi), or keep one
  value per server until a real need shows up? (Lean: one value — YAGNI.)
