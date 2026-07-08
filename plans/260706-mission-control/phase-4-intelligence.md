# Rung 4 — Intelligence

**Status:** Master design + sub-phase A red suite (2026-07-08). No implementation.
**North-star row:** `plan.md` Rung 4 — observability, global timeline, nuncio-as-MCP, dispatcher.
**Guardrails:** ADR-004 provider-neutral, ADR-006 SQLite/manual migrations only if needed, ADR-007 no new session event types for observability, ADR-008 same auth model for MCP, product vision says Nuncio never calls model APIs directly.

## Code Reality

| Seam | Current state | Design consequence |
|---|---|---|
| Provider usage | Pi exposes model catalog cost metadata only; Pi run events persist text/thinking/tool/status, not usage. Codex app-server client ignores `^CToken usage:` control lines. Cursor SDK path handles text/tool/thinking deltas and drops other update categories. | v1 reports exact token/cost as `unknown` unless a provider emits structured usage later. Do not estimate cost from characters. |
| Durable rows | `sessions`, `events`, `tasks`, `loop_runs`, `attention_items`, `digest_runs`, `schedules`, `steer_queue`. | Sub-phase A can be pure folds + read-only REST over existing rows. |
| Verify and steer | `verify_result`, `verify_retry`, `verify_needs_attention`, `steer_message`, `steer_queued` already exist. | Verify pass rate and steer count are derivable today. No new event type. |
| Digest | Rung 3 has `buildDigest()`, `gatherDigestCounts()`, `digest_runs`, heartbeat morning/evening. | Global timeline feeds digest enrichment after A, not before. |
| Attention | `attention_items` is durable, ranked, ack/resolve-aware. | Dispatcher v1 drafts from attention rows instead of creating a parallel inbox. |
| Scheduler | `{kind:'system'}` schedules already run heartbeat jobs. | Dispatcher cadence should ride an evening system job. |
| Auth | `AuthGuard` and WS upgrade use loopback trust, token/cookie, Tailscale whois. | HTTP MCP endpoint must sit under `/api` and inherit AuthGuard; stdio MCP is local loopback-equivalent. |

## Sub-Phase Order

| Phase | Name | Depends on | Why this order |
|---|---|---|---|
| **A** | Observability data layer | existing rows | The rest reads this. Build the honest metrics contract first. |
| **B** | Global timeline + digest enrichment | A + Rung 3 heartbeat | Timeline is the "what happened while I slept" view and the digest input. It needs A's normalized facts. |
| **C** | Nuncio-as-MCP | A/B API shapes + ADR-008 | Agents need stable read APIs before tool wrapping. MCP can then expose session/verify/timeline/task enqueue safely. |
| **D** | Dispatcher v1 rules + approve-in-one-tap | A/B/C + attention | Rules draft tomorrow from open attention, stale work, failed verifies, PRs. Approval enqueues via existing task path. |
| **Seam only** | Dispatcher v2 agent session | C/D | Design only: an ordinary provider session granted the Nuncio MCP, proposes only. No model API calls in Nuncio. |

## Founder-Decision Table — LOCKED (founder, 2026-07-08): all 9 as recommended

| Decision | Recommendation | Why | Trade-off |
|---|---|---|---|
| Token/cost source honesty | **Report `unknown` tokens/cost in v1 unless a provider emits structured usage. Count turns, durations, steers, verify outcomes now.** | Current Pi/Codex/Cursor adapters do not persist exact per-turn usage. Pi catalog cost is price metadata, not run usage; Codex usage lines are ignored; Cursor result duration exists but no token count. | Honest but less flashy. Cost budgets wait for provider-specific usage capture. |
| Observability storage | **Derive on demand first. Add a rollup table only after UI/API latency proves need.** | All v1 facts are durable already; a rollup table duplicates truth and needs rebuild semantics. | Large histories may need indexes or caching later. |
| MCP transport + auth | **Ship both seams in this order: stdio MCP for local hosted agents first; HTTP MCP under `/api/mcp` second, using ADR-008 token/tailnet auth.** | Stdio is easiest for local agents and avoids exposing new network auth. HTTP is needed for remote/tailnet agents and should reuse AuthGuard exactly. | Two transports, one tool surface. HTTP waits until tool surface is stable. |
| MCP surface v1 | **Read-mostly plus constrained mutations: list sessions, read session/timeline/verify/attention, enqueue task proposal/task, pause loop. No archive/delete/settings writes.** | Dispatcher needs enqueue and maybe loop pause; destructive founder actions stay human. | Agents can create work but cannot clean up everything themselves. |
| Dispatcher draft storage | **Store drafts as `attention_items` kind `dispatcher-proposal` with payload linking proposed tasks. Do not add a proposals table until proposal lifecycle outgrows ack/resolve.** | One founder queue remains one queue. Ack/resolve already exists and passes phone test. | `attention_items` payload gets richer; if drafts need versioning/comments later, split table then. |
| Approve semantics | **One tap creates queued `tasks` from the proposal payload, stamps the attention item resolved, and records an ordinary audit row/event in task outcome or proposal payload.** | Existing task runner owns execution; approval is founder authority boundary. | Approval must be idempotent to survive double taps/retry. |
| Dispatcher v1 rules | **Draft from open unacked attention, broken loops, stale PR-review items, failed verify windows, queued/running starvation, and yesterday failed loop/task runs.** | These are durable and actionable today. No model needed. | Rules are blunt; v2 can propose better once data exists. |
| Dispatcher cadence | **Evening pre-flight system job after digest, default daily ~20:05 local, founder-tunable. Manual "draft now" endpoint for dogfood.** | Matches cockpit rhythm and avoids competing with morning retrospective. | If evening queue is empty, no proposal item. |
| Dispatcher v2 authority | **Founder-locked proposes-only.** | Product says Nuncio is not an LLM harness; v2 is an ordinary provider session with MCP tools. | Autonomy is lower by design. |

## Direction-Test Walk

- **Phone test:** A exposes UI-ready REST; B digest/timeline fit the phone; D approval is one tap.
- **Engine test:** metrics slice by provider string from sessions/tasks; no provider branch outside adapters.
- **Forge test:** PR/stale-review signals come through existing forge-neutral attention/fleet seams.
- **Restart test:** A derives from durable rows; B timeline windows use persisted event/task/loop timestamps; D proposals persist as attention rows.
- **Self-host test:** all local SQLite + daemon scheduler + local MCP. No SaaS control plane.
- **Attention test:** every sub-phase raises decisions-per-minute-of-attention: facts first, timeline summary, agent-readable API, then one-tap queue approval.

# Sub-Phase A Design — Observability Data Layer

## Exact Metrics Derivable Today

| Metric | Source rows | Notes |
|---|---|---|
| Sessions created/completed/error/running | `sessions.status`, `sessions.created_at`, `events.status` | Completion = current IDLE/ARCHIVED with last event in window. |
| Turn count | `events.type IN ('user_message','steer_message')` | Human initial prompt + steers; provider-neutral. |
| Steer count | `steer_message` and `steer_queued` | Split human vs auto by `payload.origin === 'verify_retry'`. |
| Verify pass rate | `verify_result.payload.ok` | `passed / total`; null when no verify rows. |
| Verify retries / needs-attention | `verify_retry`, `verify_needs_attention` | Existing events. |
| Duration | `status RUNNING` → next terminal `status IDLE/ERROR/PAUSED` per session | Exact for persisted status events; open run duration uses injected clock. |
| Task throughput | `tasks.status`, `started_at`, `finished_at`, `session_id` | Queued/running/done/failed/cancelled. |
| Loop throughput | `loop_runs.outcome`, `verify`, `day_bucket`, `created_at` | Already day-bucketed. |
| Attention volume | `attention_items.created_at/resolved_at/status/kind/severity` | Open/unacked/current plus window deltas. |
| Provider/project rollups | join by session/task provider and project path | Unknown/null project grouped as `unassigned`. Unknown provider tolerated by string. |
| Timeline facts | existing events + tasks + loop_runs + attention_items + digest_runs | Normalized to UI-ready entries, sorted by timestamp. |
| Token/cost | none exact today | `tokens: null`, `costUsd: null`, `source: 'unavailable'` until provider emits usage. |

## Dimensions

- **session** — one `SessionObservabilityDto` per session.
- **task** — task-linked session facts plus task queue/finish facts.
- **loop** — `loop_runs` facts by loop and day.
- **provider** — provider id string from session/task/loop engine.
- **project** — normalized project path, `unassigned` when null.
- **day** — local day bucket supplied by caller/injected clock helpers.

## Pure Folds

- `foldSessionMetrics({ session, events, now })`
- `foldWindowSummary({ sessions, eventsBySession, tasks, loopRuns, attentionItems, window, now })`
- `foldRollups({ sessions, eventsBySession, tasks, loopRuns, window, now })`
- `buildGlobalTimeline({ sessions, eventsBySession, tasks, loopRuns, attentionItems, digests, window })`

All folds are pure: no DB, no `Date.now()`, no provider calls. Tests inject `now`.

## REST Shape

```http
GET /api/observability/summary?from=&to=
GET /api/observability/sessions/:id?from=&to=
GET /api/observability/rollups?dimension=provider|project|day&from=&to=
GET /api/observability/timeline?from=&to=&projectPath=&provider=
```

Responses:

- `summary`: totals, verify pass rate, steer counts, duration, attention, token/cost availability.
- `sessions/:id`: one session metrics object plus verify/steer/duration detail.
- `rollups`: array of `{ dimension, key, label, metrics }`.
- `timeline`: array of normalized entries with `{ id, at, kind, title, projectPath, provider, sessionId?, taskId?, loopId?, severity? }`.

## Storage Decision

Sub-phase A uses **derive-on-demand only**. No new table, no migration, no new event types. Add indexes later only if query scans hurt. Add a rollup table only after live history makes REST slow.

## Red Suite

- `observability-folds.spec.ts`
  - empty world all zeros/unknown usage.
  - single session counts initial turn, human steer, auto steer, verify pass rate, closed duration.
  - multi-provider/project rollups tolerate unknown provider and `unassigned` project.
  - window boundaries are `[from, to)`.
  - restart rebuild returns the same folds from the same durable rows.
  - open run duration uses injected `now`.
- `observability-timeline.spec.ts`
  - global timeline orders session/task/loop/attention/digest facts by timestamp.
  - timeline filters by provider/project.
  - unknown provider/project does not throw.
- `observability-adr007.spec.ts`
  - observability reads existing event types only; no usage/metric session event is added.

## Open Questions

1. Approve `dispatcher-proposal` as an attention kind, or prefer a separate `proposals` table from day one?
2. Should HTTP MCP ship in sub-phase C v1, or stdio-only first?
3. What exact evening dispatcher default time: `20:05` local OK?

# Sub-Phase B Design — Global Timeline + Digest Enrichment

## Global Timeline Contract

`GET /api/timeline?from=&to=&before=&limit=` is the phone-first shortcut for the
"what happened while I slept" view. `GET /api/observability/timeline` remains as
the observability namespace alias and accepts the same query. The fold derives
entries from existing durable rows only: sessions, session events, tasks,
loop_runs, attention_items, and digest_runs. It adds no event types and no
storage. Default window is since the most recent digest window boundary; if no
digest exists, use the last 24 hours from injected `now`.

Each entry is a UI-ready one-liner:

`{ id, ts, kind, title, projectPath, provider, sessionId?, taskId?, loopId?, attentionId?, prUrl?, outcome?, verify?, severity? }`

Kinds are concrete facts, not source tables:

- `session-started`, `session-completed`, `session-needs-you`
- `loop-run-settled`, `breaker-tripped`, `breaker-resumed`
- `attention-raised`, `attention-resolved`
- `task-done`, `task-failed`
- `pr-opened-detected`

Ordering is newest first for REST. Pagination uses `before` as an exclusive
timestamp cursor and `limit` capped server-side. Equal timestamps sort by
significance, then stable id, so repeated requests cannot reshuffle the feed.
Window semantics stay `[from, to)`.

## Digest Enrichment

`buildDigest()` gets additive sections:

- `highlights`: top N timeline entries in the digest window, sorted by simple
  significance first, then newest. Significance order: needs-you > breaker >
  failures > completions > neutral.
- `projectLines`: one line per project from observability rollups, e.g.
  `nuncio: 6 runs, 5 green, 1 needs you`.

The heartbeat service supplies both from the observability A folds. It must not
recount verify/task/attention facts locally beyond formatting the existing
rollup output.

## Red Suite

- Timeline fold: merge ordering, `[from,to)` boundaries, `before` pagination
  stability, empty window, unknown-kind tolerance, per-kind shaping.
- Timeline REST: `/api/timeline` is wired through AppModule and accepts default
  window + pagination query.
- Digest enrichment: highlight significance order, per-project one-liners,
  empty world stays honest zeros/empty arrays.
- Restart determinism: same durable rows produce the same timeline and digest
  enrichment after rebuilding sources.

## Web Follow-up

Verified `packages/core/src/attention-api.ts` normalizes missing legacy digest
sections and `apps/web/src/components/digest-view.tsx` reads only known fields.
Additive `highlights` and `projectLines` will not break the current view, but
they are not rendered until a web round adds those sections.

# Sub-Phase C Design — Nuncio-as-MCP

## Packaging

Ship a **thin stdio proxy** as `bun run mcp` / `bun run --filter @nuncio/server mcp`.
The entrypoint lives under `apps/server/src/mcp-stdio/` and connects to the
already-running daemon over `NUNCIO_API_ORIGIN` (default
`http://127.0.0.1:3000`). This keeps the MCP process small: no second Nest DI
graph, no SQLite handle, no provider runtime, and no duplicate auth rules.
Loopback rides ADR-008 loopback trust; non-loopback daemon access uses
`NUNCIO_AUTH_TOKEN` as a Bearer token. HTTP MCP remains a later transport under
`/api/mcp`, behind the existing AuthGuard.

## Dependency Choice

`@modelcontextprotocol/sdk@1.29.0` is present only as transitive lockfile/cache
metadata in this checkout and is not importable from the workspace under Bun.
Adding it directly would also bring the SDK plus `zod` peer and HTTP/OAuth
dependencies for a tools-only stdio server. Sub-phase C uses a minimal
line-delimited JSON-RPC implementation for the MCP tools subset:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

If a future HTTP transport ships, re-evaluate the SDK as a direct dependency.

## Tool Surface

All tools are written for agent dispatchers and return JSON text plus
`structuredContent` using existing REST DTO shapes.

| Tool | Purpose | Daemon API |
|---|---|---|
| `nuncio_list_sessions` | List Nuncio sessions so an agent can find active, idle, or archived work. | `GET /api/sessions` |
| `nuncio_get_session` | Read one session detail plus observability/verify summary. | `GET /api/sessions/:id`, `GET /api/observability/sessions/:id` |
| `nuncio_get_timeline` | Read the global timeline with pagination/filter passthrough. | `GET /api/timeline` |
| `nuncio_get_attention` | Read the ranked founder attention inbox and counts. | `GET /api/attention` |
| `nuncio_get_fleet` | Read fleet health rows for all projects. | `GET /api/fleet` |
| `nuncio_list_loops` | List Autopilot loops. | `GET /api/loops` |
| `nuncio_enqueue_task` | Enqueue a constrained task through the existing task queue. | `POST /api/tasks` |
| `nuncio_pause_loop` | Pause one loop and return the paused loop DTO. | `POST /api/loops/:id/pause` |

Mutation surface is locked to exactly `nuncio_enqueue_task` and
`nuncio_pause_loop`. No archive/delete/restore/settings/cancel/retry tools in
v1.

## Safety Rails

- The MCP process never calls model APIs. It is only a local tool server.
- Mutations return explicit action objects (`enqueued`, `paused`) and the REST
  DTO returned by the daemon.
- Daemon errors become MCP tool errors with the daemon's message. Configured
  auth tokens and Bearer values are redacted before returning errors.
- Input schemas are typed JSON Schema. Runtime validation mirrors existing REST
  validation for required task prompts and loop ids.
- The destructive-tool guard enumerates registered tools and fails if a
  destructive tool name appears.

## Red Suite

- `mcp-stdio-protocol.spec.ts`
  - initialize handshake advertises tools-only capability.
  - tool list returns the exact agent-readable names and schemas.
  - read tool calls a stub daemon API and returns structured content.
  - daemon errors surface as MCP tool errors with token redaction.
- `mcp-stdio-mutations.spec.ts`
  - mutation surface is exactly enqueue task + pause loop; no destructive tool
    names.
  - enqueue trims/forwards task input and returns `action: enqueued`.
  - enqueue validation errors return MCP tool errors.
  - pause loop calls the existing loop API and returns `action: paused`.

# Sub-Phase D Design — Dispatcher v1 Rules + Approve-In-One-Tap

## Storage + Authority

Dispatcher v1 is deterministic. It never calls a model and never creates a
parallel proposal table. A draft is one open `attention_items` row:

- `kind`: `dispatcher-proposal`
- `subjectId`: `dispatch:<YYYY-MM-DD>` using local day
- `severity`: 2, the nearest existing integer bucket between `anomaly` (1) and
  `pr-review` (2). It is an FYI-plus bundle: more actionable than a generic
  anomaly but not more urgent than a single PR review.
- `title`: `Dispatcher proposal for <YYYY-MM-DD>`
- `payload.proposals`: capped ordered list of proposed queued tasks
- `payload.approvedAt` and `payload.taskIds`: approval audit, written once

Approve-in-one-tap creates queued tasks from the payload through the existing
task enqueue path, then resolves the attention item. Approval is idempotent: if
`taskIds` already exists, the service returns the same ids and never enqueues
again. Partial approval is v1.1. The v1 phone contract is intentionally
one-tap-all; subset selection adds UI state, per-proposal audit, and harder retry
semantics without changing the core attention thesis.

## Rule Inputs

Rules fold over the same durable facts used by timeline, fleet, and attention:
open attention rows, sessions/events, tasks, loops, loop runs, and project
defaults. Rules do not issue duplicate queries when a caller already has these
sources; repository collection is only the service boundary.

## Rule List

1. Open unacked attention: propose `Handle <title>` for high-signal open items
   that are not themselves dispatcher proposals.
2. Broken loop: propose `Resume or investigate <loop>` from an open
   `tripped-breaker` item or a loop with `status='broken'`.
3. Stale PR review: if an open `pr-review` item is older than 24h, propose
   `Review or merge PR #<number>`.
4. Failed verify window: from an open `verify-dead` item or a session with a
   latest `verify_needs_attention` and no later green `verify_result`, propose
   `Fix the failing verify in <project>`.
5. Yesterday all-failed loop: when all settled runs for a loop yesterday failed
   and count is non-zero, propose `Investigate why <loop> failed N times`.
6. Yesterday failed task runs: for failed standalone tasks created yesterday,
   propose `Investigate failed task: <prompt>`.
7. Queued/running starvation: if a queued task is older than 2h, or a running
   task is older than 4h, propose `Unblock queued task: <prompt>` or
   `Check running task: <prompt>`.

Every proposal has `{ title, prompt, projectPath, engine?, model?, rationale }`.
`engine`/`model` come from the source loop or project defaults when available.
`rationale` names the source fact in one line. The list is deduped against:

- existing open dispatcher proposals
- existing queued/running tasks for the same subject
- duplicate subjects inside the same fold

The list is capped to the top 5 by the same attention ranking shape: severity
first, project importance next, older source fact first. Empty folds create no
attention item; silence is success.

## Cadence + API

The daemon ensures one system schedule:

- target: `{ kind: 'system', job: 'dispatcher-evening' }`
- setting key: `NUNCIO_DISPATCHER_EVENING_SPEC`
- default: `daily@20:05`

The scheduler's existing system handler fires `draftEvening()`. Dogfood uses
`POST /api/dispatcher/draft-now`; approval uses
`POST /api/dispatcher/proposals/:id/approve`.

## Red Suite

- Pure folds: each source fact produces the expected proposal shape; in-flight
  dedup suppresses duplicates; cap trims to 5; empty world returns no proposals.
- Draft idempotency: drafting twice for the same local evening updates/replaces
  the open `dispatcher-proposal` row for `dispatch:<date>` and never stacks.
- Approval happy path: creates queued tasks, resolves the item, writes
  `approvedAt` and `taskIds` into payload.
- Approval idempotency: re-approval returns the same `taskIds` and creates no
  duplicate tasks.
- Approval failure: enqueue errors leave the item open with no partial audit,
  so retry can safely try again.
- Scheduler wiring: the 20:05 system job calls the dispatcher draft handler.
- REST: `POST /dispatcher/draft-now` and
  `POST /dispatcher/proposals/:id/approve` call the service.
- ADR-007 guard: dispatcher introduces no new session event types.
