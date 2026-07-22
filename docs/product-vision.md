# Product Vision (PRD)

North-star document for Nuncio. Every agent working on this codebase reads this **before**
`docs/product-surfaces.md` (where capabilities live across clients) and
`docs/system-architecture.md` (internals). When a change conflicts with this document, stop and ask
the user — do not silently reinterpret the direction.

## One-line thesis

**Nuncio is a Cursor-quality agent harness that runs on your own machine, routes all your
subscriptions, and never calls work done without visible evidence.**

It is a **desktop-first** control surface — with a native mobile app for reviewing and steering —
that turns the user's own always-on computer into a first-class agent backend: one engine Nuncio
controls, every subscription the user already pays for, and proof for every change.

## What changed (2026-07-22 refocus)

Nuncio began as "one surface for N vendor engines." That is no longer the thesis — Claude Code
desktop and Cursor desktop already own the single-vendor experience, and matching five vendor UIs
is a treadmill. Nuncio now invests in **one engine it controls** and differentiates on the two
things a vendor harness structurally *cannot* do: route a competitor's subscription, and gate work
behind evidence.

- **Single engine.** **Nuncio Engine** (the Pi coding agent plus Nuncio's own extensions) is the
  only engine that receives investment. The vendor engines (Claude, Codex, Cursor, Cursor CLI,
  Devin) are now **legacy: hidden by default behind the `engines.showLegacy` setting, not deleted.**
  Every existing legacy-engine session keeps opening, streaming, and resuming — the engines are
  hidden from the pickers, not removed.
- **Desktop-first.** The Electron desktop app is the primary surface (it loads the web renderer —
  that renderer code stays). Plain browser access is no longer a supported surface. Mobile stays
  **native Expo**, dedicated to reviewing and steering work from a phone.

## The problem

Vendor agent products each solve half the problem and lock the other half:

| Vendor offering | What it locks |
|---|---|
| Cursor background agents, Claude Code cloud, Codex cloud | Run **only on vendor VMs**. You cannot point them at your own machine, your local checkouts, your local credentials, your tailnet. |
| Every vendor harness | Routes **only its own subscription**. Cursor will never spend your Codex or Claude quota; Claude Code will never spend your Grok quota. |
| All of them | Report work as "done" from the model's own say-so. There is no built-in, machine-owned proof that the change actually runs. |

The user already owns a capable, always-on machine with every credential configured (`gh`, `glab`,
Pi, Codex, Cursor, Claude, Grok). Nuncio makes that machine the agent backend: delegate from the
phone, the agent runs at home on one engine, subscriptions the user already pays for feed that
engine, and every change comes back with evidence.

## Product pillars

Ranked. When two pillars conflict, the higher one wins.

1. **Your-machine-as-cloud.** The backend is the user's own computer (Mac today), reached over
   Tailscale HTTPS. No VPS, no public SaaS, no vendor VM. Local credentials, local checkouts,
   local worktrees are features, not liabilities.
2. **One engine, made great.** Nuncio Engine is the product. Investment goes into making a single
   engine excellent — its context, tools, gate integrity, and extensions — not into breadth across
   vendor engines. The `AgentProvider` contract still exists and still hosts the legacy engines, but
   it is now plumbing for backward compatibility, not the differentiator.
3. **Subscription freedom.** A neutral local harness can route the user's vendor subscriptions
   (Codex, Claude, Grok, …) into Nuncio Engine's model picker through the managed subscription
   bridge. **No vendor harness will ever route a competitor's subscription — a neutral one can.**
   This is a structural advantage, not a feature.
4. **Evidence over claims.** Nuncio never reports work "done" on the model's word. A change is
   backed by machine-owned proof: a green verify, then a screenshot of the running app, then the
   agent driving the app, then a recorded video delivered to the phone (see [Evidence
   ladder](#evidence-ladder-the-roadmap-spine)).
5. **Async-first, delegate-and-review.** A session is a delegated background task, not a realtime
   chat. Optimize for: create from phone → agent runs for minutes/hours → review → steer.
   Durability (event log, resumability, restart recovery) beats latency polish.
6. **Self-hosted privacy.** Nothing leaves the tailnet. Open source (MIT); friends self-host on
   their own machines.

## Evidence ladder (the roadmap spine)

Evidence is the backbone of the roadmap. Each rung raises the bar for what "done" means, and each
builds on the one below:

- **(a) Screenshot-after-build evidence gate.** When a turn reaches a green verify on a UI-touching
  change, Nuncio screenshots the running app and attaches it to the transcript. The definition of
  done includes visible proof, not just a passing command.
- **(b) The agent drives the app.** The engine exercises the change itself — through the browser or
  an iOS simulator — so the evidence is interaction, not a static frame.
- **(c) Recorded video to the phone.** The change is captured as a short recorded walkthrough and
  delivered to the phone for review, so the user can approve real behavior from anywhere.

## Factory-as-skills (long arc)

The long-term shape — "a company of agents" (dev, product, marketing) — is **not** a new
orchestration substrate. It emerges as a **library of skills** layered on top of one good engine
plus the substrate that already exists (tasks, dispatcher, loops). Building more orchestration
machinery is a non-goal; growing the skill library on top of Nuncio Engine is the path.

## Dogfood inversion rule

Every Nuncio dev task runs through **Nuncio Engine**. Fleeing to Cursor or Claude Code to get
unblocked is allowed — but every flight costs **one line in the pain log**
([`plans/260722-engine-refocus/pain-log.md`](../plans/260722-engine-refocus/pain-log.md)). Those
lines are the engine backlog: they name exactly where the engine is not yet good enough to build
itself.

## Users

- **Primary:** the owner-operator (Oscar) — orchestrates agents rather than writing code by hand,
  works from desktop and iPhone, dogfoods Nuncio to build Nuncio.
- **Secondary:** self-hosting friends/colleagues on their own machines and tailnets.

## What Nuncio is NOT (non-goals)

- **Not a hosted SaaS.** No public domain, no multi-tenant server, no vendor-VM execution.
- **Not a realtime pair-programming chat.** Streaming exists to review, not to converse at 60fps.
- **Not "one surface for N vendor engines" anymore.** Nuncio invests in Nuncio Engine. The legacy
  vendor engines are kept working for existing sessions, not extended.
- **Not a new orchestration substrate.** The multi-agent "factory" is skills on top of the existing
  tasks/dispatcher/loops, not a new scheduler.
- **Not a plain web app.** Desktop (Electron) is the primary surface; a browser tab is not a
  supported way to run Nuncio. Mobile is a native review/steer client.
- **Not an IDE.** File explorer, terminal, browser dock exist to *review agent work*, not to
  replace Cursor/VS Code for hand-editing.

## Release channels

`dev` branch → **Nuncio Dev** builds (the user's daily test bed). `main` → **stable** releases
(Changesets-curated changelog, signed desktop builds). A change is not "done" until it is safe to
ride this train: green suite, changeset, docs synced.

## Direction tests

Before building or reviewing any feature, walk these five questions. A "no" is a design smell to
raise, not necessarily a blocker:

1. **Phone test** — can the user review and steer it from the native mobile app over Tailscale, or
   is it desktop-only by explicit decision (e.g. browser dock)?
2. **Engine test** — does it make **Nuncio Engine** better? Investing new behavior in a legacy
   vendor engine instead of Nuncio Engine is a direction smell.
3. **Subscription test** — does it respect subscription freedom (route the user's own vendor
   subscriptions), rather than assuming one vendor's billing?
4. **Evidence test** — does the change come back with machine-owned proof (verify → screenshot →
   drive → video), or only the model's claim that it worked?
5. **Restart / self-host test** — does it survive a server restart (state rebuilt from the event
   log) and still work with zero cloud services beyond the SDKs themselves?

## Where the rest lives

- Operational conventions, commands, gotchas → [`AGENTS.md`](../AGENTS.md)
- Locked technical decisions + rationale → [`docs/architecture-decisions.md`](architecture-decisions.md)
- How to test and self-verify without the user → [`docs/testing-and-verification.md`](testing-and-verification.md)
- System internals → [`docs/system-architecture.md`](system-architecture.md)
- Capability → surface map across clients → [`docs/product-surfaces.md`](product-surfaces.md)
- Phased roadmap → [`plans/`](../plans/)
