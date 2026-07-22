# Architecture Decision Records

Locked decisions with rationale. Read after [`docs/product-vision.md`](product-vision.md).

**How to use this file:** decisions here are *verified and sticky*. An audit finding or a
refactor idea alone is not grounds to reverse one — reverse only when the stated "Reverse only
if" condition is met, and surface the reversal to the user first. Append new ADRs at the bottom;
never renumber. When a decision is superseded, mark it `Superseded by ADR-NNN` instead of
deleting it.

Format: **Status · Decision · Why · Reverse only if.**

---

## ADR-001 — Your-machine-as-cloud deployment

**Status:** locked (product thesis).
**Decision:** single Bun process on the user's own always-on machine, exposed over Tailscale
HTTPS. Desktop (Electron), web/PWA, and mobile (Expo) are all thin clients of that one daemon.
**Why:** vendor cloud agents refuse to run on the user's machine; the user's machine already has
every credential and checkout. Privacy: nothing leaves the tailnet.
**Reverse only if:** the user explicitly asks for a hosted/multi-tenant mode.

## ADR-002 — Bun runtime (server, build, tests)

**Status:** locked, shipped.
**Decision:** Bun ≥ 1.3 everywhere; `bun:sqlite` for persistence; `bun test` for server suites.
The server does not run under Node.
**Why:** one tool, fast installs/tests, built-in SQLite without native-addon toolchain; Pi SDK is
itself built with Bun.
**Reverse only if:** a hard Bun blocker appears in a core dependency with no escape hatch
(precedent: Cursor SDK needed `useHttp1ForAgent` + `JsonlLocalAgentStore` — escape hatches were
found, Bun stayed).

## ADR-003 — In-process agent loops, three-layer state decoupling

**Status:** locked, shipped.
**Decision:** one process hosts many agent sessions. State splits into: (1) **conversation** —
durable append-only event log in SQLite with a `seq` cursor; (2) **agent loop** — disposable
in-process SDK session, rebuildable from the log; (3) **machine state** — a strict FSM on
`sessions.status`, mutated only via `assertTransition`.
**Why:** long-running resumable sessions at personal scale (3–5 concurrent). A crash loses only
the loop, never the conversation.
**Reverse only if:** scale or isolation needs (untrusted multi-user) outgrow one process — a
scope change the user must decide.

## ADR-004 — Provider-agnostic `AgentProvider` contract (generic-first)

> **Amended by ADR-014 (2026-07-22).** The `AgentProvider` contract stays — it is now backward-compat plumbing that keeps the legacy engines resolvable — but hosting N engines is no longer the thesis. Nuncio Engine is the only engine invested in and shown by default; the generic-first rules below still apply to the engines that remain.

**Status:** locked, shipped. The single most important code-level rule.
**Decision:** every engine (Pi, Codex, Cursor, Claude next) implements the same `AgentProvider`
interface behind `AgentRegistry`. `BaseAgentProvider` owns shared orchestration
(RUNNING→IDLE, error handling, event push); a concrete provider implements `executePrompt()` plus
adapter details only. Engine differences are expressed as **declarative capability flags and
optional methods** (`capabilities.interrupt`, `modelSwitch`, `images`, `supportsInteraction?()`),
never as `if (id === 'pi')` branches in `SessionsService` or the UI. The event schema
(`assistant_delta`, `tool_start/end`, `thinking_*`, …) is shared; adapters map SDK deltas into it.
**Why:** the whole point of Nuncio is hosting N engines with one session layer and one UI.
Per-engine branches rot into N parallel apps.
**Reverse only if:** never. An SDK that "doesn't fit" means the contract grows a capability, not
that the UI forks. Before writing any provider code, run the checklist in
[AGENTS.md → Agent providers](../AGENTS.md#agent-providers).

## ADR-005 — Forge-neutral `ForgeProvider` contract, CLI-first auth

**Status:** locked, shipped (`apps/server/src/forges/`).
**Decision:** GitHub and GitLab implement one `ForgeProvider` contract (mirroring the agent
triad: interface + base + registry). Auth reuses `gh` / `glab` CLI tokens or PAT settings — never
an OAuth web flow. Unsupported forge actions render **disabled with a reason** in the UI, never a
prompt to authenticate elsewhere. Webhook vocabulary is normalized inside each provider (e.g.
GitLab `open` → `opened`).
**Why:** GitLab parity is a core differentiator (pillar 3); the user's machines already hold CLI
credentials.
**Reverse only if:** the user asks for OAuth or a new forge that truly cannot map to the contract.

## ADR-006 — SQLite, append-only events, no migration framework

**Status:** locked, shipped.
**Decision:** single `bun:sqlite` DB (WAL) under `NUNCIO_DATA_DIR`. Events are append-only with a
per-session `seq`. Schema changes are guarded manual `ALTER TABLE`s behind `PRAGMA table_info`
checks (template: `DatabaseService.migrate()`). SQL uses positional `?` params only.
**Why:** personal scale; one file to back up; zero infra. Named params silently bind NULL under
`bun:sqlite` with unprefixed keys.
**Reverse only if:** schema churn makes guarded ALTERs error-prone enough that the user approves
adopting a migration tool.

## ADR-007 — WS relay + seq-cursor replay as the streaming transport

**Status:** locked, contract frozen in [`docs/ws-relay-contract.md`](ws-relay-contract.md).
**Decision:** clients consume `/api/sessions/ws` (subscribe/steer RPC, bounded outbound buffer,
`behind` marker, resume via `since=<seq>`). SSE + cursor replay endpoints remain for API
consumers. The event log is the cursor; reconnect is always gap-free replay, never "hope we
didn't miss anything".
**Why:** phones sleep, tailnets drop; durability + replay beats realtime plumbing (pillar 4).
**Reverse only if:** the frozen contract gains a versioned successor — additive changes only.

## ADR-008 — Auth: loopback trust + token + Tailscale whois

**Status:** locked, shipped (`AuthGuard` + `upgrade-auth.ts`).
**Decision:** loopback is always trusted; remote needs the auto-generated Bearer token/cookie or
same-account Tailscale whois. Applies to every `/api` route AND WS upgrades. Forge webhooks are
exempt (HMAC-verified).
**Why:** zero-setup local use; safe tailnet remote use; no accounts system to run.
**Reverse only if:** multi-user/multi-tenant scope change decided by the user.

## ADR-009 — TDD-first with curated releases (Changesets)

**Status:** locked working practice.
**Decision:** red → green → refactor for every change; no bug fix without a regression test;
user-facing PRs ship a hand-written changeset that becomes the release note verbatim; docs sync
(`README.md`/`AGENTS.md`) is part of "done". `dev` produces Nuncio Dev builds; `main` produces
stable releases.
**Why:** the user does not hand-write code — the test suite and changelog are how a
non-programmer owner keeps N agents honest over time.
**Reverse only if:** never wholesale; per-step pragmatism is allowed when the user says so
(direct execution preference), but verify substance stays.

## ADR-010 — Monorepo, one daemon, many clients

> **Amended by ADR-014 (2026-07-22).** Desktop (Electron) is the primary surface and loads the web renderer; a standalone browser tab is no longer a supported client. Mobile (Expo) is the review/steer client. The monorepo / one-daemon shape is unchanged.

**Status:** locked, shipped.
**Decision:** `apps/server` (daemon) + `apps/web` (PWA) + `apps/desktop` (Electron shell
supervising the daemon) + `apps/mobile` (Expo) + `packages/core` (portable client layer: API
client, relay client, transcript parser, design tokens). The daemon serves the built web UI
same-origin; desktop/web/mobile are all clients of the same API.
**Why:** one source of truth for the client layer; "web version" is a serving mode, not a fork.
**Reverse only if:** never split repos without user decision.

## ADR-011 — Engine scope is deliberate: stabilize before adding

> **Superseded by ADR-014 (2026-07-22).** Scope narrowed from "stabilize the existing engines before adding" to a single invested engine (Nuncio Engine); the legacy engines are hidden by default, not stabilized further.

**Status:** active direction (2026-07).
**Decision:** current focus is durability + task-queue lanes and dogfooding on the existing
engines (Pi, Codex, Cursor, and Claude). A new engine lands only when the user schedules it, and it
must pass the provider conformance suite
([testing-and-verification.md](testing-and-verification.md#provider-conformance-suite)) before merge.
**Why:** each engine multiplies the test surface; the contract must be proven stable on the
engines we have.
**Reverse only if:** the user re-prioritizes.

## ADR-014 — Engine refocus: one engine, desktop-first, evidence-led (2026-07-22)

**Status:** locked (product thesis). Authorized by Oscar in the 2026-07-22 direction session.
Supersedes the "one surface for N engines" framing; amends ADR-004 and ADR-010, and supersedes
ADR-011.
**Decision:**
- **One engine.** Nuncio Engine (the Pi coding agent + Nuncio's own extensions) is the only engine
  Nuncio invests in and the only one shown in every picker by default. The vendor engines (Claude,
  Codex, Cursor, Cursor CLI, Devin) are **legacy: hidden behind the `engines.showLegacy` boolean
  setting (default off), not deleted.** `AgentRegistry` still resolves every engine by id
  (`get(id)`), so existing legacy-engine sessions keep opening, streaming, and resuming; only the
  listing paths (`all()` / `available()`) are filtered.
- **Desktop-first.** The Electron desktop app is the primary surface. It loads the web renderer —
  that renderer code stays and is maintained — but a plain browser tab is no longer a supported way
  to run Nuncio. Mobile stays **native Expo**, dedicated to reviewing and steering.
- **Subscription freedom is a pillar.** The managed subscription bridge routes the user's vendor
  subscriptions (Codex, Claude, Grok, …) into Nuncio Engine's model picker. No vendor harness will
  route a competitor's subscription; a neutral local harness can — this is the structural reason a
  single-engine Nuncio still beats using the vendor apps directly.
- **Evidence is the roadmap spine.** Work is never "done" on the model's claim. The ladder:
  (a) screenshot-after-build evidence gate → (b) the agent drives the app (browser / iOS simulator)
  → (c) a recorded video of the change delivered to the phone for review.
- **Factory-as-skills, no new substrate.** The "company of agents" arc grows as a library of skills
  on top of one good engine plus the existing tasks / dispatcher / loops. Building a new
  orchestration substrate is a non-goal.
- **Dogfood inversion.** Every Nuncio dev task runs through Nuncio Engine; each escape to a vendor
  tool costs one line in the pain log, which is the engine backlog.
**Why:** matching five vendor UIs is a treadmill Nuncio loses — Claude Code and Cursor already own
the single-vendor experience. A neutral, self-hosted harness wins on the two things a vendor cannot
do (route a competitor's subscription; gate work behind machine-owned evidence), and those only pay
off if investment concentrates on one engine Nuncio controls.
**Reverse only if:** the user re-opens multi-engine breadth as the thesis, or asks to restore a
supported browser surface. Deleting (not hiding) the legacy engines is a separate, later decision
gated on engine trust and an open-source milestone.
