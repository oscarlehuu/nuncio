# Workstream C — Orchestration Tools (pull-based context + agent-initiated delegation)

Rides the existing session-bound runtime-tools seam
([agent-runtime-tools.types.ts](../../apps/server/src/agents/tools/agent-runtime-tools.types.ts)):
`AgentRuntimeTools { systemPromptAppend, tools[] }` already flows into providers through
`AgentRunContext.tools` and is adapted per engine (codex/cursor adapters exist). So v1 needs
**no MCP server at all** — every engine that supports runtime tools gets these natively; C4
wraps the same registry as a real MCP server later for external/unhosted agents.

Pull beats push for context economy: instead of stuffing sibling context into every prompt,
an engine fetches exactly the slice it needs, when it needs it, at summary granularity first.

---

## C1 — Read-only orchestration tools

**Goal.** A running session can observe the fleet: sibling sessions, task outcomes, verify
results — all compact, all budgeted.

**Module** — `apps/server/src/orchestration/tools/orchestration-tools.factory.ts`:
`buildOrchestrationTools(deps, scope): AgentRuntimeTool[]` where
`scope = { sessionId, projectPath }`. Registered into the session's `AgentRuntimeTools` by the
same registry that builds today's tool set (`agent-tool-registry.ts`), behind setting
`NUNCIO_ORCHESTRATION_TOOLS` = `off` (default until dogfooded) | `read` | `read-write`.

**Tools (exact contracts):**

1. `nuncio_list_sessions`
   - input: `{ status?: 'RUNNING'|'IDLE'|'PAUSED'|'ERROR', limit?: number }` (limit ≤ 20,
     default 10; always scoped to the caller's `projectPath` — cross-project listing is
     deliberately not offered v1)
   - output (structuredContent): `[{ id, title, status, provider, branch, updatedAt,
     isAncestor, isChild }]` — no previews, no prompts (list stays ~100 B/row).

2. `nuncio_read_session`
   - input: `{ sessionId: string, sinceSeq?: number, budgetBytes?: number }` (budget ≤ 8192,
     default 4096)
   - output: text = B5 `renderEventsSince` compaction; structuredContent =
     `{ status, lastSeq, verify: lastVerifyResult | null }`.
   - Guard: target must share the caller's `projectPath` or be in the caller's lineage
     (A6 walk); otherwise `isError` with reason.

3. `nuncio_list_tasks`
   - input: `{ parentSessionId?: string }` (default: caller's own session)
   - output: `[{ id, status, prompt: first120chars, sessionId, verifyPassed, finishedAt }]`.

4. `nuncio_get_task_result`
   - input: `{ taskId: string }`
   - output: the A4 `TaskCompletedPayload` digest (built on demand for terminal tasks whose
     digest event predates this feature), plus `briefGoal` from `contextBrief`.

5. `nuncio_list_project_facts`
   - input: `{}` — caller's project only
   - output: `ContextFactDto[]` (key, value, provenance, pinned).

**systemPromptAppend** (one shared paragraph, profile-wrappable via D2): tells the engine the
tools exist, that summaries come first, and that `nuncio_read_session` with `sinceSeq` is the
escalation path — mirroring the progressive-disclosure protocol (one-liner → digest → compact
slice; full transcripts are never exposed through tools).

**Security posture.** Tools are same-machine, same-founder — the guard rails above are about
context hygiene (don't let an agent drown itself) and blast-radius habit, not multi-tenant
security (ADR-001: no hosted mode).

**Tests.** Factory spec with stubbed services: schema validity of every `inputSchema` (compile
against JSON-schema meta), project scoping enforced, lineage exception works, budgets clamped,
`off` setting yields empty tool list. Level-3: one supertest-driven session (mock provider)
proving tools arrive in `AgentRunContext.tools`.

**Acceptance.** A mock-provider session calls `nuncio_list_sessions` and receives only
same-project rows; reading a foreign-project session errors.

---

## C2 — Write tools: `nuncio_enqueue_task` + `nuncio_record_project_fact`

**Goal.** Agent-initiated delegation with agent-authored briefs (the LLM-quality brief path A2
deliberately deferred), and agent knowledge capture under B3 rules.

**Enabled only when** `NUNCIO_ORCHESTRATION_TOOLS=read-write`.

1. `nuncio_enqueue_task`
   - input:
     ```json
     { "prompt": "string (required)",
       "brief": { "goal": "string (required)", "constraints": ["…"], "decisions": ["…"],
                   "files": ["…"], "doneCriteria": ["…"] },
       "tag": "mechanical|review|design|research (optional, C3 routing)",
       "provider": "string (optional, explicit override)",
       "useWorktree": "boolean (default true)" }
     ```
   - Behavior: builds `CreateTaskDto` with `parentSessionId` = caller, `role: 'subagent'`,
     `contextBrief` = supplied brief **merged with** A3 workspace snapshot +
     A2 verify-command resolution (agent supplies intent; nuncio supplies ground truth).
     Provider resolution: explicit `provider` > C3 tag routing > existing subagent defaults
     ([multitask-defaults.ts](../../apps/server/src/tasks/multitask-defaults.ts)).
   - output: `{ taskId, resolvedProvider, resolvedModel, queuePosition }`.
   - Guards: A5's depth cap applies at enqueue (chain ≥ 2 → error telling the agent to report
     to its parent instead); per-session cap 10 open subagent tasks; prompt+brief ≤ 16 KB.
   - **Approval:** enqueue is queue-only (execution consumes budget later), so v1 requires the
     existing provider-approval hook only when the session's permission mode already gates
     tools — no bespoke approval UI. Revisit after dogfood.

2. `nuncio_record_project_fact`
   - input: `{ key, value, pinned? }` — provenance forced to `agent`,
     `source_session_id` = caller.
   - Behavior: B3 rules verbatim; result text distinguishes `written` vs
     `proposed (founder fact exists)` vs validation error.

**Round-trip with A5.** When the child finishes, the digest lands on the caller's log (A4) and,
under `steer` policy, wakes the caller — completing agent→agent delegation with no founder in
the loop and founder-visible artifacts at every hop.

**Tests.** Enqueue tool spec: brief merging (agent intent + nuncio snapshot), routing
precedence order, depth/open-task caps, oversized input rejected. Fact tool spec: three-outcome
matrix. Integration (level 3): mock session calls enqueue → task row exists with brief; child
completion appends digest to caller.

**Acceptance.** In one dogfood run, a Pi session decomposes a request, enqueues a Codex
subagent with a self-authored brief, and reacts to the digest — founder only watches.

---

## C3 — Tag-based engine routing (dispatcher-lite, deterministic)

**Goal.** "Send mechanical work to the cheap engine, review to a different engine than the
author" as data, not code — the deterministic seed of the rung-4 dispatcher.

**Storage.** Settings key `NUNCIO_ENGINE_ROUTING` (JSON, editable in the settings UI):

```json
{ "mechanical": { "provider": "cursor", "model": "…" },
  "review":     { "provider": "codex", "avoidAuthorProvider": true },
  "design":     { "provider": "pi" },
  "research":   { "provider": "pi" } }
```

**Resolver** — `apps/server/src/orchestration/engine-routing.ts`:
`resolveRoute(tag, authorProvider, settings): { provider?, model? } | null`.
- Unknown tag / no table → null (callers fall through to existing defaults).
- `avoidAuthorProvider`: if the routed provider equals the delegating session's provider, pick
  the first *other* available provider from the registry (`AgentRegistry.available()`), else
  keep (with a logged note). This encodes cross-engine review diversity as policy.
- Availability check at resolution time; unavailable → fall through to defaults (a routing
  table must never strand a task).

**Consumers.** C2 enqueue tool; `POST /api/tasks` accepts `tag` too so the UI/CLI get the same
routing; A2's multitask path does **not** auto-tag (explicit only, v1).

**Tests.** Resolver table test: hit, miss, avoid-author swap, avoid-author with only one
available provider, unavailable-provider fall-through. Malformed JSON in the setting → null +
one warning log (never throws).

**Acceptance.** A `review`-tagged task authored from a Pi session lands on a non-Pi engine when
one is available.

---

## C4 — Standalone MCP server over the same registry (rung-4 alignment)

**Goal.** The identical tool contracts, reachable by engines nuncio does *not* host (a Claude
Code session on the founder's laptop, the future dispatcher) — this is the mission-control
rung-4 "nuncio-as-MCP" deliverable, built as a thin shell.

**Scope note.** Gated on rung 2+ being underway; specified now so C1/C2 are written
server-shape-compatible from the start (both consume the same
`buildOrchestrationTools` factory — the invariant that makes C4 thin).

**Shape.**
- `apps/server/src/mcp/mcp.controller.ts`: streamable-HTTP MCP endpoint `POST /mcp` on the
  existing daemon HTTP server (no second port; Tailscale reachability for free — phone test).
- Auth: bearer token minted in settings (`NUNCIO_MCP_TOKEN`), constant-time compare; requests
  without it → 401. Token visible/regenerable in the settings UI.
- Session scoping: an external caller has no `sessionId`; scope is
  `{ projectPath: required query param }`, and lineage-based guards degrade to
  project-only. Depth-cap treats external callers as depth 0.
- Tool list = exactly `buildOrchestrationTools` output for the negotiated scope, read-only
  unless the token was minted with `read-write` (second settings toggle).
- Protocol layer: implement against the MCP spec with the official TS SDK **only if** its
  transitive weight is acceptable to the server bundle; otherwise hand-roll the
  streamable-HTTP JSON-RPC subset we need (initialize, tools/list, tools/call) — decide at
  implementation with a size check, note the choice in `docs/architecture-decisions.md`.
- Registration doc: one README section showing `claude mcp add nuncio --transport http
  http://<host>:3000/mcp?projectPath=… --header "Authorization: Bearer …"` and the Codex
  config equivalent.

**Tests.** Level-3 supertest: initialize → tools/list parity with the factory, tools/call
happy path, 401 without token, read-write tool absent on a read token.

**Acceptance.** A laptop Claude Code session lists nuncio sessions and enqueues a task over
Tailscale using only the documented registration line.
