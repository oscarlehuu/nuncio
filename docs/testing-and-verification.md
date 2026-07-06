# Testing & Verification

How agents prove a change works **without the user launching the app**. The user orchestrates —
they do not hand-verify. "It compiles" or "the tester agent said PASS" is not proof; the levels
below are.

Companion to [AGENTS.md → Working practice: TDD-first](../AGENTS.md#working-practice-tdd-first)
(the red→green→refactor gate). This document covers *what to test* and *how to self-verify*.

## Verification pyramid

From cheapest to most faithful. Every change must be verified at the **highest level it can
reach without user help**, plus the levels below it.

| Level | What | Command | Needs credentials? |
|---|---|---|---|
| 1 | Server unit (domain-grouped) | `bun run test` | no |
| 2 | Web component (vitest, jsdom) | `bun run --filter @nuncio/web test` | no |
| 3 | HTTP e2e (simulated provider) | `bun run --filter @nuncio/server test:e2e` | no |
| 4 | Aggregate gate | `bun run test:daily-driver` | no |
| 5 | Real browser against a live dev stack | playwright-core → system Chrome (below) | no (Mock provider) |
| 6 | Real-provider integration | `test:integration` / `test:integration:codex` | yes (gated, self-skipping) |

Plus always: `bun run build` and `bun run lint` — a change that doesn't compile is not at level 0,
it is nowhere.

## Self-verify playbook (no user in the loop)

Pick by change type. The **Mock provider** is always available with zero credentials — use it to
exercise the full session lifecycle (create → RUNNING → deltas → IDLE → steer) end-to-end.

| You changed… | Verify with |
|---|---|
| Domain logic, repos, FSM, services | Level 1 spec written first (TDD), then levels 3–4 |
| API shape / controller behavior | Level 3 (supertest over HTTP, simulated provider) |
| Provider adapter | Level 1 with a stubbed SDK + conformance suite (below); level 6 if the matching CLI login exists on this machine (check first — it often does) |
| Web component logic | Level 2 first; but jsdom **cannot** validate layout, Radix portals/popovers, colors, scroll, focus — those need level 5 |
| Anything visual/interactive | Level 5: real Chrome. jsdom-green + browser-unverified = **not done** |
| Streaming / reconnect / lifecycle timing | Level 1 event-log assertions with fake timers + a level 5 pass watching the real transcript |

**Level 5 recipe (real browser, no user):** start the stack yourself — `bun run --filter
@nuncio/server start` (port 3000; `start`, not `dev`, when a provider subprocess must survive DB
writes) + `bun run --filter @nuncio/web dev` (5173) — then drive **system Chrome via
`playwright-core`** (installed at repo root; launch with `channel: 'chrome'`, no bundled browser
download). Create a Mock-provider session through the UI, assert on the DOM, screenshot both
themes when the change is visual. Kill your servers when done; respect the canonical-ports rule
in [AGENTS.md → Dev servers](../AGENTS.md#dev-servers--reuse-canonical-ports).

**Report proof, not vibes:** the completion message states which levels ran, the exact commands,
and pass counts. If a level was skipped, say why (e.g. "no `codex login` on this machine").

## Edge-case heuristics (write these tests without being told)

The user cannot enumerate edge cases — the heuristics below are the enumeration. For any change
touching session lifecycle, streaming, or provider state, walk the table and add a spec for every
row that applies. Name specs by scenario (`steer-while-running.spec.ts` style), never by bug id.

| # | Heuristic | Ask yourself | Example specs |
|---|---|---|---|
| 1 | **State × event matrix** | For *each* FSM state, what does *each* API verb do? Don't test only the happy path's state. | steer while RUNNING (queued), interrupt while IDLE (409), delete while not ARCHIVED (rejected) |
| 2 | **Projection lag / races** | Derived state (composer enabled, status dot, unread) is computed from events — can it lag or contradict the source state? | *Real bug:* session reached IDLE but the composer stayed locked for seconds — the UI projection trailed the status event. Test: after the IDLE event is appended, the enable-projection must flip **immediately**, no timer between |
| 3 | **Restart / resume** | Kill the process mid-X. What must survive? What must be reconciled on boot? | queued steers restored on boot; sessions stuck RUNNING reconciled; stale provider approvals denied with reason |
| 4 | **Reconnect / replay** | Drop the WS mid-stream. Is resume from `since=<seq>` gap-free and duplicate-free? | dedupe by seq; `behind` marker resubscribe; visibilitychange resync |
| 5 | **Boundaries** | Empty, zero, huge, truncated. | empty prompt, 0 events, 4KB payload truncation, transcript with 10k events |
| 6 | **Failure paths** | Provider unavailable, auth expired, git error, subprocess dies mid-run. Session must land ERROR/IDLE — never stuck RUNNING. | worktree git failure → no orphan session row; provider crash → ERROR + error event |
| 7 | **Concurrency** | Two of the same thing at once. | two steers racing; watcher vs in-process producer (the `locallyProducing` guard); two tabs subscribed |
| 8 | **Idempotency** | Run it twice. | re-import same handoff chat → same session; duplicate event append rejected/deduped |

**The sibling rule:** every bug fix ships its regression test (mandatory, see AGENTS.md) **and**
one look sideways — the same heuristic row usually hides siblings. The idle-composer bug (row 2)
implies checking every other event-derived UI projection for the same lag pattern in the same PR.

**Make races unit-testable:** extract event-derived UI state into **pure projection functions**
in `packages/core` (pattern: `buildTranscriptBlocks()`). A pure `(events, status) →
{composerEnabled, …}` function turns a timing bug into a table-driven unit test. If you find
yourself needing a real browser + stopwatch to reproduce a state bug, that state should probably
become a pure projection first.

## Provider conformance suite

**Status: standing investment — extend it whenever a gap appears.** One shared spec factory that
every provider must pass, so edge cases are written once and every engine (current and future)
inherits them — this is [ADR-004](architecture-decisions.md#adr-004--provider-agnostic-agentprovider-contract-generic-first)
made executable.

- Shape: `describeAgentProviderContract(makeProvider)` in `apps/server/test/unit/agents/`,
  instantiated per provider with its SDK stubbed at the adapter boundary.
- Asserts, for every provider: run drives CREATED→RUNNING→IDLE; deltas arrive as shared
  `assistant_delta` and coalesce; terminal `assistant_message` matches the SDK's authoritative
  text; errors land ERROR with an `error` event; dispose is idempotent; steer after dispose
  revives from the event log; capability honesty — a declared-off capability must reject cleanly
  (e.g. `interrupt: false` → 409), a declared-on one must work.
- **Gate:** a new engine PR (Claude next) must run the suite green before merge; a new
  session-layer behavior must be added to the suite, not to one provider's specs.

## What "invest more in tests" means here

Priority order when adding test depth (highest leverage first):

1. Conformance suite rows for any session-layer behavior that currently only one provider tests.
2. Pure projections + their table tests for every event-derived UI state (row 2 above).
3. Restart/reconnect specs (rows 3–4) for any new durable state.
4. A scripted level-5 browser smoke (create → stream → steer → archive on Mock) runnable as one
   command — extend it when a UI flow becomes load-bearing.
5. Real-provider integration only for adapter seams that stubs cannot prove (auth discovery,
   cwd/tool binding, resume).

Never: snapshot tests of whole components, tests that assert implementation details, or sleeps —
use fake timers or event hooks.
