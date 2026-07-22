# Task 01 — Reorientation: docs, legacy-engine hiding, pain log

Date: 2026-07-22 · Authorized by Oscar in the 2026-07-22 direction session.
This task is the paper trail for revising previously-locked multi-engine decisions;
`docs/architecture-decisions.md` is updated as part of it (supersede, never delete history).

## Context — the decision this task implements

Nuncio refocuses on a **single engine**. New one-line thesis:

> **Nuncio is a Cursor-quality agent harness that runs on your own machine, routes all your
> subscriptions, and never calls work done without visible evidence.**

What changed (2026-07-22):

- **Nuncio Engine (pi + extensions) is the only engine that receives investment.** Vendor engines
  (claude, codex, cursor, cursor-cli, devin) become **legacy: hidden by default, not deleted**.
  "One surface for N engines" is no longer the product thesis — Claude Code desktop and Cursor
  desktop already own that experience.
- **Desktop-first.** The Electron desktop app is the primary surface (it loads the web renderer —
  that code stays). Browser access is no longer a supported surface. Mobile stays **native Expo**,
  as the review/steer surface.
- **Subscription freedom is a core pillar:** the subscription-bridge (managed cli-proxy-api host)
  routes the user's vendor subscriptions (Codex/Claude/Grok/…) into Nuncio Engine's model picker.
  No vendor harness will ever route a competitor's subscription; a neutral local harness can.
- **Evidence ladder is the roadmap spine:** (a) screenshot-after-build evidence gate → (b) agent
  drives the app (browser / iOS simulator) → (c) recorded video of the change delivered to the
  phone for review.
- **Factory-as-skills long arc:** "a company of agents" (dev, product, marketing) emerges as a
  library of skills on top of one good engine + the existing tasks/dispatcher/loops substrate.
  No new orchestration substrate gets built.
- **Crew is deprecated pending removal** (Oscar's call). Not touched in this task.
- **Dogfood inversion rule:** every nuncio dev task runs through Nuncio Engine. Fleeing to
  Cursor/Claude Code is allowed but costs one line in the pain log (see Workstream 3).

## Goals

1. The north-star docs describe the new direction — they steer every future agent session.
2. Legacy engines are hidden by default behind a settings flag; Nuncio Engine is the only
   visible engine in every picker (web, mobile, desktop).
3. The pain-log scaffold exists and documents the escape-hatch protocol.

## Non-goals — hard boundaries

- **Delete no code.** Provider implementations, crew, web renderer: untouched.
- No memories work, no evidence-gate work (that is Task 02).
- No changes to `NUNCIO_FORCE_MOCK` behavior or the cursor-cli special case in `get()`.
- No plan-artifact references (file names, task numbers) in code comments, test names, or
  migration names — comments explain the why in domain terms only.

## Workstream 1 — Docs reorientation

Files: `docs/product-vision.md` (rewrite around the new thesis), `AGENTS.md` ("What is Nuncio"
block: single engine, desktop-first, crew deprecated, drop the "provider-agnostic by design /
inaugural provider" framing), `docs/product-surfaces.md` (surfaces: desktop Electron + native
mobile; browser unsupported; engines section), `docs/architecture-decisions.md` (add a new locked
decision for the 2026-07-22 refocus; mark superseded decisions with date + pointer — keep history).

Guidance:

- Keep each doc's existing structure and tone; rewrite content in place. Do not append a
  contradicting section next to a stale one.
- Carry every bullet from **Context** above into `product-vision.md` (thesis, pillars, evidence
  ladder, subscription freedom, factory-as-skills, dogfood inversion, legacy-engine status).
- Sweep for load-bearing stale claims: `grep -ri "provider-agnostic\|inaugural\|web app\|crew" docs/ README.md AGENTS.md`.
  Fix the load-bearing ones; list the leftovers in the PR description instead of fixing everything.

## Workstream 2 — Hide legacy engines behind a settings flag

Design:

- New boolean setting `engines.showLegacy`, default `false`, registered in
  `apps/server/src/settings/settings.registry.ts` following the `forges.autoSteer` pattern.
- `AgentRegistry` (`apps/server/src/agents/agents.registry.ts`) filters the **listing** paths —
  `all()` and `available()` — down to the pi provider when the flag is off.

Traps (each one is a test case):

- `get(id)` must keep resolving **every** provider, hidden or not — existing sessions created with
  legacy engines must still open, render transcripts, and resume.
- `all()` is sync while settings reads may be async — the registry already subscribes to
  `settings.onChange(() => this.bustCaches())`; follow that caching pattern rather than making
  listing async-on-every-call.
- The models picker (`apps/server/src/models/models.service.ts` builds from `available()`)
  collapses automatically once the registry filters — verify the web picker AND the mobile picker
  both show only Nuncio Engine models (mobile consumes the same server API).
- Mock provider rules unchanged (`NUNCIO_FORCE_MOCK` opt-in only).
- Check whether the settings UI renders registry-driven booleans automatically; if not, surface
  the toggle wherever `forges.autoSteer` surfaces today. Label it "Show legacy engines".

TDD-first per AGENTS.md: failing spec under `apps/server/test/unit/agents/` before the registry
change; settings-registration spec follows the existing settings spec conventions.

## Workstream 3 — Pain log

Create `plans/260722-engine-refocus/pain-log.md`:

```markdown
# Pain log — escape-hatch protocol

Rule: every nuncio dev task runs through Nuncio Engine. Fleeing to Cursor/Claude Code is
allowed, but every flight costs one line here. These lines ARE the engine backlog — review weekly.

| Date | What I was doing | Why I left |
|------|------------------|------------|
```

## Definition of done

- [ ] `docs/product-vision.md`, `AGENTS.md`, `docs/product-surfaces.md`,
      `docs/architecture-decisions.md` updated; a fresh agent reading AGENTS.md answers
      "what is Nuncio, which engines are supported?" with the new thesis and "Nuncio Engine
      (legacy engines hidden behind a flag)".
- [ ] With the flag off (default): every engine/model picker (web + mobile API) lists only
      Nuncio Engine; flag on restores legacy engines without restart weirdness.
- [ ] An existing legacy-engine session (e.g. an old codex session) still opens and renders.
- [ ] New unit specs green; full affected suites green (`bun test` for touched domains); lint clean.
- [ ] No code deleted; crew and provider implementations untouched.
- [ ] Conventional commits, no AI references, no plan references in code.
- [ ] PR description lists: stale doc claims found but not fixed, and any engine pain hit while
      doing this task (seed material for the pain log).

## Out of scope / what comes next

- **Task 02 — Evidence rung (a):** screenshot-after-build evidence gate wired into the engine's
  definition of done (capture-evidence-tool + browser module + simulator-evidence-capture exist).
- **Later:** crew removal surgery (~6.3k server lines + 49 web files + 18 core files) as a
  dogfood task once engine trust is built; delete (not hide) legacy engines before any
  open-source milestone.
