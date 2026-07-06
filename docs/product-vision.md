# Product Vision (PRD)

North-star document for Nuncio. Every agent working on this codebase reads this **before**
`docs/system-architecture.md`. When a change conflicts with this document, stop and ask the user —
do not silently reinterpret the direction.

## One-line thesis

**Nuncio is a self-hosted Agent Development Environment (ADE): your machine as the cloud.**

It is a desktop + mobile + web control surface that turns the user's own always-on computer into
the "cloud agent" backend that vendor products refuse to provide.

## The problem

Vendor agent products each solve half the problem and lock the other half:

| Vendor offering | What it locks |
|---|---|
| Cursor background agents, Claude Code cloud, Codex cloud | Run **only on vendor VMs**. You cannot point them at your own machine, your local checkouts, your local credentials, your tailnet. |
| Cursor / Claude Code / Codex generally | **GitLab support is weak or absent** — GitHub is assumed. |
| All of them | Each has its own UI, session model, and transcript. No single place to delegate, watch, and steer them all — especially from a phone. |

The user already owns a capable, always-on machine with every credential configured (`gh`, `glab`,
Pi, Codex, Cursor). Nuncio makes that machine the agent cloud: delegate from the phone, the agent
runs at home, review and steer later.

## Product pillars

Ranked. When two pillars conflict, the higher one wins.

1. **Your-machine-as-cloud.** The backend is the user's own computer (Mac today), reached over
   Tailscale HTTPS. No VPS, no public SaaS, no vendor VM. Local credentials, local checkouts,
   local worktrees are features, not liabilities.
2. **Engine-neutral.** Pi, Codex, Cursor today; Claude next. Every engine plugs into the one
   `AgentProvider` contract (capability flags + optional methods). The session layer, event
   schema, and UI never branch per engine. See [ADR-004](architecture-decisions.md#adr-004--provider-agnostic-agentprovider-contract-generic-first).
3. **Forge-neutral.** GitHub **and GitLab** are first-class, through the `ForgeProvider` contract
   mirroring the agent triad. Auth is CLI-first (`gh` / `glab` tokens); unsupported forge actions
   render disabled with a reason — never an OAuth prompt.
4. **Async-first, delegate-and-review.** A session is a delegated background task, not a realtime
   chat. Optimize for: create from phone → agent runs for minutes/hours → review → steer.
   Durability (event log, resumability, restart recovery) beats latency polish.
5. **Self-hosted privacy.** Nothing leaves the tailnet. Open source (MIT); friends self-host on
   their own machines.

## Users

- **Primary:** the owner-operator (Oscar) — orchestrates agents rather than writing code by hand,
  works from desktop and iPhone, dogfoods Nuncio to build Nuncio.
- **Secondary:** self-hosting friends/colleagues on their own machines and tailnets.

## What Nuncio is NOT (non-goals)

- **Not a hosted SaaS.** No public domain, no multi-tenant server, no vendor-VM execution.
- **Not a realtime pair-programming chat.** Streaming exists to review, not to converse at 60fps.
- **Not an LLM harness.** Nuncio never talks to model APIs directly — it drives existing agent
  SDKs/CLIs that the user already pays for and has logged into.
- **Not per-engine products.** No bespoke UI, session model, or event type for one engine. If an
  SDK cannot fit the shared contract, the contract grows a capability flag — the UI does not fork.
- **Not an IDE.** File explorer, terminal, browser dock exist to *review agent work*, not to
  replace Cursor/VS Code for hand-editing.

## Release channels

`dev` branch → **Nuncio Dev** builds (the user's daily test bed). `main` → **stable** releases
(Changesets-curated changelog, signed desktop builds). A change is not "done" until it is safe to
ride this train: green suite, changeset, docs synced.

## Direction tests

Before building or reviewing any feature, walk these five questions. A "no" is a design smell to
raise, not necessarily a blocker:

1. **Phone test** — does it work from the iPhone PWA / Expo app over Tailscale, or is it
   desktop-only by explicit decision (e.g. browser dock)?
2. **Engine test** — does it reach all engines through `AgentProvider` capabilities, or did it
   hardcode one engine? (`if (provider === 'pi')` outside `providers/` is a bug.)
3. **Forge test** — does it work on GitLab as well as GitHub through `ForgeProvider`?
4. **Restart test** — does it survive a server restart? (State rebuilt from the event log; no
   in-memory-only truth for anything the user would miss.)
5. **Self-host test** — does it still work with zero cloud services beyond the SDKs themselves?

## Where the rest lives

- Operational conventions, commands, gotchas → [`AGENTS.md`](../AGENTS.md)
- Locked technical decisions + rationale → [`docs/architecture-decisions.md`](architecture-decisions.md)
- How to test and self-verify without the user → [`docs/testing-and-verification.md`](testing-and-verification.md)
- System internals → [`docs/system-architecture.md`](system-architecture.md)
- Phased roadmap → [`plans/`](../plans/)
