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

**Single-command gates.** `bun run gate` bundles the pre-commit bar — build + lint + level 1 (server
unit) + `test:scripts` — and is the minimum every change must pass before commit. `bun run gate:full`
is the pre-promotion (dev→main) bar: everything in `gate` plus levels 2 (web unit), 3 (server e2e),
and 5 (real-browser smoke via `test:smoke-ui`). CI keeps these as separate steps for readable failure
output — the gates are for local runs, not a CI replacement.

**Ratchet gates (CI).** Two baseline-diff gates run on every PR; both fail only on *new* debt:

- **Dead code** — `bun run check-dead-code` runs knip over the monorepo and compares against
  `scripts/dead-code-baseline.json`. New unused files/exports/deps fail CI; existing findings are
  accepted debt to burn down. After deleting dead code (or intentionally accepting a finding), run
  `bun run check-dead-code:update`.
- **Coverage** — `bun run check-coverage-ratchet` reads the server lcov + web json-summary reports
  (produced by each package's `test:coverage`) and fails any target whose line coverage dropped
  below `scripts/coverage-baseline.json` minus the tolerance. When coverage improves, ratchet the
  floor up with `bun run check-coverage-ratchet:update`.

**Failure evidence (CI).** The real-browser smoke records a Playwright trace for the whole run and
saves it (plus a failure screenshot, both named for the failing `journey-step`) to
`smoke-artifacts/` only when a step fails; CI uploads that directory as the `smoke-artifacts`
artifact. Open traces with `bunx playwright show-trace <zip>`.

## Self-verify playbook (no user in the loop)

Pick by change type. The **Mock provider** needs zero credentials — it is registered only when
the server starts with `NUNCIO_FORCE_MOCK=1` (never in normal runs) — use it to exercise the full
session lifecycle (create → RUNNING → deltas → IDLE → steer) end-to-end.

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
| 4 | **Reconnect / replay** | Drop or half-open the WS mid-stream. Is resume from `since=<seq>` gap-free and duplicate-free? Can a late REST bootstrap/refetch overwrite a newer live event? | dedupe by seq; `behind` marker resubscribe; `server_shutdown` notice → shared-pool resubscribe from lastSeq; missed-pong termination; visibility/foreground resync; hung bootstrap fallback; late REST merge |
| 5 | **Boundaries** | Empty, zero, huge, truncated. | empty prompt, 0 events, 4KB payload truncation, transcript with 10k events, slow consumer exceeding the relay buffer cap |
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

## Crew verification matrix

Crew is a separate durable aggregate with a higher evidence bar than an ordinary Session. Run
server unit commands from `apps/server`:

```bash
bun test test/unit/crew/
bun test test/unit/agents/agent-runtime-policy.contract.spec.ts
bun test test/unit/sessions/sessions.verify-gate.spec.ts
bun run test:e2e
bun run lint
```

Then run portable-client surfaces from the repository root:

```bash
bun run --filter @nuncio/core check
bun run --filter @nuncio/web test
bun run --filter @nuncio/web build
bun run --filter @nuncio/web lint
bun run --filter @nuncio/mobile check
```

The release gate remains `bun run gate`; final promotion proof remains `bun run gate:full` plus
interactive acceptance where available. Report each layer separately rather than treating one
package's green suite as full Crew proof.

| Contract | Required proof |
|---|---|
| Fixed state machine | Exact six-phase happy path; illegal tuples/events; mandatory Verify/Review; terminal immutability; duplicate idempotency |
| Profile readiness | Only `ready`/`needs_setup`; live Pi/Codex/Claude binding/model; independent Reviewer; exact runtime policy; verify command; cached operational host-sandbox probe, not binary existence |
| Runtime authority | Read-only Foreman/Reviewer; workspace-write Builder; network disabled; path/symlink/`.git` escape denial; generic task/multitask rejects Crew-owned parents; policy persists through resume |
| Workspace ownership | One worktree; one `builder:primary` lease; clean/reachable full-head boundaries; stale head invalidates gates |
| Retry/freshness | Independent default 2/2 caps; same Builder Session; reused Reviewer in loop; strict fresh final Reviewer only after review feedback |
| Deterministic Verify | Exit/timeout/spawn/abort/overflow; Seatbelt/bubblewrap refusal when absent or unusable; macOS host-data default deny; post-command boundary unchanged |
| Artifacts | Redaction before storage; SHA/byte integrity; run scoping; fail-closed diff/output bounds; UTF-8-safe `nextOffset`; loading/error/end UI |
| Recovery | Crash at every durable boundary including checkpoint→result→lease release; replay equals projection; no duplicate commit/task/result/event; exact-base worktree adoption; exact-head Verify rerun; dirty Build marker; provider loss blocks without substitution |
| Successors | Exact prior revision/head; retained canonical worktree; new snapshot/gates; old run byte-stable; compatible Foreman/Builder continuation only |
| Clients | Solo default; selected base branch participates in mobile/web readiness and creation; server-authored readiness; fixed phase order; valid expected-revision actions; aborted Verify is not failed; bounded latest-per-task summaries; current evidence only; narrow responsive layout |

Runtime-policy adapter unit tests prove mapping and path/tool enforcement without spending model
turns. When matching credentials exist, use the opt-in Pi/Codex/Claude integration suites with the
cheapest available model to confirm the provider-native boundary. A missing credential is a
reported skip, not permission to weaken the structural test.

Crew HTTP e2e is part of `apps/server`'s `test:e2e` script
(`app.e2e-spec.ts` plus `crew.e2e-spec.ts`). Browser smoke uses the existing
`scripts/smoke-ui.mjs` stack and forced Mock provider; do not create a second harness. For visual
acceptance, verify the 390 px mobile viewport, desktop viewport, current gate artifacts,
member-session links, terminal successor action, and absence of controls outside the fixed local
workflow.

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
4. The scripted level-5 browser **journey suite** — **`bun run test:smoke-ui`**
   (`scripts/smoke-ui.mjs` orchestrates one hermetic ephemeral-port stack, `NUNCIO_FORCE_MOCK=1`,
   and drives real Chrome through small per-feature journeys under `scripts/journeys/`). Beyond the
   Solo lifecycle + delegation + Crew golden paths, it carries regression guards for the UI bugs
   that have escaped: `archive-last-session` (no blank-screen when the final session is archived),
   `model-preferences-per-composer` (model choice is scoped per composer, no cross-leak),
   `transcript-selection-copy` (highlight survives and auto-copies), `theme-switch-mid-session`
   (dark ↔ light keeps the transcript/composer usable and styled), and `websocket-reconnect` (the
   harness restarts the server process mid-session; the client resubscribes from `lastSeq`,
   gap-free and duplicate-free). Add a journey — a kebab-case module under `scripts/journeys/` that
   registers named steps via the shared `record()` — when a UI flow becomes load-bearing; do **not**
   stand up a second stack.
5. Real-provider integration only for adapter seams that stubs cannot prove (auth discovery,
   cwd/tool binding, resume).

## Interactive desktop smokes: engine/model cost rule

Computer-use smokes on the Electron dev app (Codex or any driver) default to the **mock provider**
(`NUNCIO_FORCE_MOCK=1`) — free and fast. When a scenario genuinely needs a real engine (adapter
seams, real streaming), pick the **cheapest model**, never a flagship:

- Cursor → `composer-2.5`
- Pi → `claude-haiku-4.5`
- Codex → the mini tier (smallest available codex model)

Set it per session/loop via the model picker (or the loop's engine·model override) as part of the
smoke setup. A smoke that burns a flagship-model turn to check a chip renders is a bug in the
smoke, not a cost of doing business.

Never: snapshot tests of whole components, tests that assert implementation details, or sleeps —
use fake timers or event hooks.
