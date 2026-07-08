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

## Founder-Decision Table

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
