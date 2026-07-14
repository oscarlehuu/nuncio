# Melbourne Program v2 — multi-team parallel delegation

**Window:** 2026-07-12 (Sat) → 2026-07-16 (Thu, departure), then continued from Melbourne.
**Teams (founder-tuned 2026-07-12):** orchestrator (Claude Fable) · gpt-5.6-sol (backend build
high, review/design-spike xhigh) · Opus (frontend web/RN) · Sonnet (mid UI) · gpt-5.6-terra/luna
xhigh (cheap scout, scans, mechanical backend — replaces Haiku and spark) · cursor grok-4.5 (top
tier; heavy aux — grok has no "xhigh" naming) + grok-4.5-high (medium aux) · composer-2.5-fast
(light). **Not used:** gpt-5.3-spark, Gemini CLI provider (N2 dropped by founder decision).

**Track P — Nuncio Mobile as a real app (new, founder priority):** the current `apps/mobile` is a
skeleton; the goal is a full phone app in the style of Codex mobile / Cursor mobile.
- **P0** Full interactive HTML prototype (all screens, tappable flows) — approve before RN work.
- **P1+** RN build waves derived from the approved prototype (Opus lead, Sonnet support); the old
  M1–M4 lanes fold into this track as its first implementation slice.

## Team mechanics (verified 2026-07-12)

| Team | Dispatch path | Verified |
|---|---|---|
| gpt-5.6-sol xhigh | codex mission per independent /tmp clone; orchestrator does push/PR/CI/merge (sandbox: no network/keyring; can run core/web vitest, not server unit) | PR #72/#73 shipped this way |
| Opus | Agent tool (`developer`/`ui-developer`, model=opus) in isolated worktrees | standing protocol |
| cursor grok-4.5 / composer-2.5 | `~/.local/bin/agent -p --model <slug>` in isolated worktrees | slugs `grok-4.5-high`, `grok-4.5-xhigh`, `composer-2.5-fast` confirmed |
| Orchestrator | clones/worktrees, server suites, browser + simulator verification, adversarial review (fresh codex session — builder never grades itself), conflict resolution, merge order | this session |

Every lane: own branch off fresh origin/dev → build → orchestrator full-suite verify → PR → CI →
**risk-tiered review** (founder directive 2026-07-12 — never stack reviewers without need):

| Tier | Lanes | Review gate |
|---|---|---|
| Light (polish/docs/mechanical) | M5, Q1, Q2 | CI + orchestrator verify only; Codex cloud review consumed if it happens to post, never waited on |
| Medium (single-surface features) | M1–M4, M6, E2, E3, E6, G1, N1 | + ONE local reviewer, always cross-model with the builder (Opus built → grok-4.5-high reviews; sol built → grok-4.5-high or Opus reviews) |
| High (engine core, relay/security, event-schema) | E1, E4, G2–G4, R1, R2, M9 | + deep reviewer at top tier (grok-4.5 or sol xhigh, fresh session) — the only tier where two model reviews may stack |

Cursor review = local CLI runs only (no cloud Bugbot — founder decision). Lanes within a wave are
file-disjoint.

## macOS-first thesis: the simulator becomes a web surface

**serve-sim** (`serve-sim@0.1.44`, Evan Bacon) streams the iOS simulator to the browser
(MJPEG/H.264 + WebSocket control) with full input — taps, swipes, pinch, keyboard, hardware
buttons, drag-drop media. It runs as **Connect middleware** (mountable on an existing server), has
a **programmatic CLI** (gestures/type/buttons/rotation), and ships an Agent Skill for AI drivers.
arm64 macOS + Node 20+ (matches the machine).

Why this reshapes the plan: once the simulator is a web surface, nuncio needs almost no new
concepts — the **existing browser panel, CDP tooling, and agents' browser skills apply to mobile
apps as-is**. Nuncio is macOS-first, so the daemon can own this natively:

- **Simulator Panel**: daemon mounts serve-sim middleware; the web UI gets a Simulator tab next to
  the browser panel; the Electron app embeds the same view. A session working on `apps/mobile`
  shows the live simulator the way web sessions show the dev server.
- **Agent control**: serve-sim CLI wrapped as session tools (`sim_tap`, `sim_type`, `sim_press`,
  `sim_screenshot`) for engines without browser tools; browser-capable engines just drive the
  panel.
- **Evidence**: before/after frames come from the same stream (or `xcrun simctl io` fallback);
  recordings via `simctl recordVideo`.

Supporting toolchain (verified on npm / machine):

- `xcrun simctl io booted screenshot|recordVideo` — zero-dependency capture baseline (iOS 26.5
  simulators present).
- **Maestro** (mobile.dev's UI-testing framework — unrelated to any local "maestro" dev-protocol
  skill; installer pending): YAML flows (`tapOn`, `inputText`, `assertVisible`, `takeScreenshot`)
  drive the RN app deterministically → `apps/mobile`'s verify command + drive-to-state for
  evidence captures.
- **idb** (Meta, optional): `describe-all` accessibility tree = a semantic `read_page` for the
  simulator; evaluate as the a11y complement to serve-sim's pixel surface.
- **mobile-mcp** `0.0.62` / **XcodeBuildMCP** `2.6.2`: npm MCP servers (sim control / build+boot
  loops) — now the *fallback* integration path for MCP-capable providers; the Simulator Panel is
  the primary one. Claude.ai's connector registry has no mobile-dev entries — these are npm MCPs.
- **Expo Orbit** (menubar build launcher) and **scrcpy** (Android mirroring) — later candidates for
  the same panel pattern; Android arrives via scrcpy when needed.

## Tracks and lanes

### Track M — Mobile cockpit (Opus lead)
- **M1** Question card in RN transcript: numbered 1–4 options, multi-select, note, Skip →
  `respondInteraction` (mobile currently read-only). *(Opus)*
- **M2** `case 'plan'` checklist + `n/m steps` on session rows via core `derivePlan`. *(Opus)*
- **M3** Push on `user_input_requested` + deep link into the session (server trigger — GPT; RN
  handling — Opus).
- **M4** Mobile evidence display: before/after pairs + stale-by-head marker (reuse
  `crew-artifact-evidence.tsx` patterns). *(Opus, after E1)*
- **M5** Mobile polish batch: attention badges, quota sheet niceties, steps chip styling.
  *(composer-2.5-fast)*

**Phone-only development — the loop is: assign → watch → answer → SEE → REVIEW → SHIP. The lanes
above cover the first three; these cover the rest so the Mac never needs its lid opened:**
- **M6** Answer from the lock screen: push notifications carry the numbered options as
  **notification actions** (iOS categories) — tap "1 · Server KV store" or "Approve" directly on
  the notification, no app open. Free-text falls back to opening the question card. Server: action
  payload in the push; RN: category registration + response POST. *(GPT push payload + Opus RN)*
- **M7** Live Activity / Dynamic Island: a running session shows `n/m steps` + phase live on the
  lock screen (expo-apple-targets widget). *(Opus, wave 4 — needs a native target)*
- **M8** Diff review on the phone: per-session changed files + syntax-highlighted diffs (the
  session-diff API already exists in core); long-press a line → comment becomes a steer. Approve /
  request-changes from the same screen. *(Opus + Sonnet)*
- **M9** Ship from the phone: PR card (status, checks list live), create-PR behind an approval
  card, merge-when-green button, CI-failure attention items deep-linking into the failing log
  excerpt. Forge APIs already exist server-side. *(GPT server surface + Opus RN)*
- **E6** Preview ON the phone: the session's dev-server URL (and the E4 serve-sim simulator
  stream — it's just a web page) tunneled through the R1 relay and opened in an in-app browser
  tab from the session screen. You build a web/mobile app and *touch it from the phone* while the
  agent works. *(GPT relay plumbing + Opus WebView screen)*
- Voice input: rely on the iOS keyboard dictation in v0 (zero work); a push-to-talk steer button
  is a later nicety.

### Track E — Evidence (GPT lead)
- **E1** Evidence service layer 1: playwright-core vs the session preview URL, MediaStore refs,
  `evidence_captured` event `{beforeRef?, afterRef?, route, viewport, workspaceHead}`, stale on
  head move, `POST /api/sessions/:id/evidence` + auto before/after at task start/done. *(GPT)*
- **E2** Web before/after transcript block + stale marker. *(Opus)*
- **E3** RN/macOS capture path: evidence service gains a `simulator` target →
  `xcrun simctl io booted screenshot|recordVideo`; install + integrate **Maestro** flows as the
  drive-to-state mechanism and as `apps/mobile`'s verify command. *(GPT + orchestrator installs)*
- **E4** **Simulator Panel (macOS-first flagship)**: daemon mounts serve-sim middleware behind
  `/api/sessions/:id/simulator`; web Simulator tab beside the browser panel; Electron embeds the
  same view; serve-sim CLI wrapped as `sim_*` session tools; evidence taps the stream. Capability-
  gated: only on macOS arm64 hosts with Xcode CLT. *(GPT server + Opus panel UI, large)*
- **E5** MCP bridge (fallback path): nuncio-managed MCP servers (mobile-mcp, XcodeBuildMCP) for
  MCP-capable providers; idb a11y-tree evaluation for a semantic simulator `read_page`.
  *(GPT, after E4)*

### Track G — Nuncio Engine (GPT lead; sequential — same files)
- **G1** `nuncio-context`: project facts + HandoffBrief via engine loader `appendSystemPrompt`,
  byte-budgeted, with a measured before/after baseline in the PR body.
- **G2** **Envoy substrate** — delegation built from scratch for the engine (the old global
  foreman/subagent extensions are *reference reading only*; nothing is ported, and the name
  "foreman" does not appear in the product). An **Envoy** is a bounded engine sub-session:
  `{profile, step, budget}` in → structured result out `{status, summary, diffRef?, evidenceRef?}`.
  Profiles live in `.nuncio/envoys/*.md` (name, model — any pi-registry model, tools allowlist,
  prompt); loaded through the engine loader factories. No TUI assumptions, no free-form prose
  results, every envoy call is budgeted and journaled as session events.
- **G3** `capture_evidence` engine tool + turn-end nudge for UI-touching diffs (needs E1).
- **G4** Verify gate: done ⇒ green verify + todos closed + evidence for UI diffs.
- **G5** Custom compaction (`session_before_compact` + exported compaction module). *(Melbourne+)*
- **G6 (PARKED by founder 2026-07-12 — design kept for later)** **Missions & the Legate (Nuncio-Engine exclusive).** Factory (docs.factory.ai) is the
  inspiration — Missions are spec-first multi-step projects, specialists have their own
  prompt/tools/model, execution can be headless — but the design below is built from scratch on
  Nuncio Engine primitives. Naming stays in Nuncio's diplomatic register: the **Legate** runs a
  Mission and dispatches **Envoys** (G2). No Factory or foreman vocabulary in the product.

  **What a Mission is.** A durable engine run with a locked spec, not an open chat:
  `{objective, repo/worktree, constraints[], doneCriteria[] (machine-checkable where possible),
  verifyCommand, budget {turns, tokens, wallClock}, policy {maxFixRounds, pushAllowed,
  approvalsRequired[]}}`.

  **What the Legate is.** NOT a model persona — a deterministic outer loop implemented in
  pi-engine (turn gates + a small reducer over session events), so it survives daemon restarts by
  construction. Phases, each gated:
  1. **Brief** — materialize spec + nuncio-context (G1); if the spec has gaps, ask ONE batched
     numbered AskUserQuestion up front, then lock the spec. No mid-mission scope drift.
  2. **Plan** — `todo_write` is mandatory; the gate refuses execution with no plan.
  3. **Execute** — steps run in the main session or are delegated to Envoys (right model per step:
     review envoy on grok, docs envoy on a cheap tier). Every envoy returns a structured result.
  4. **Verify** — run `verifyCommand`; on failure, bounded fix rounds (policy.maxFixRounds), then
     needs-attention rather than silent retry forever.
  5. **Deliver** — completion digest = the doneCriteria checklist, each item with proof (verify
     log ref, evidence pair ref, diff stat). Terminal states: `delivered`, `needs-attention`,
     `out-of-budget`. Model prose never overrides deterministic gate evidence.

  **Surface.** New-session screen gains a "Mission" pill only when engine = Nuncio Engine; the
  mission screen is a phase rail (Brief → Plan → Execute → Verify → Deliver) over the existing
  plan checklist + attention cards. Headless dispatch later rides loops/schedules.

  **Positioning vs Crew.** Crew = provider-neutral multi-engine team (already on dev). Missions =
  single-engine depth inside the pi slot — cheaper, simpler, engine-exclusive. If a mission later
  needs cross-engine members, it graduates to a CrewRun; the spec shape is kept compatible.

  Sequenced after G1 + G2 + G4; design doc wave 3, build wave 4.

### Track N — More engines (founder direction 2026-07-12 supersedes the 2026-07-02 provider freeze)
- **N1** Pi multi-provider surfacing: Grok (xAI) and Gemini models through pi's registry as
  first-class picker entries — auth probes, capability gating (images/thinking), model options
  mapping. Cheapest path to "more engines"; Grok is exclusive to the pi slot. *(GPT)*
- **N2** New provider adapter (Gemini CLI) behind the conformance suite gate — big, independent;
  candidate for grok-4.5-xhigh with GPT review. *(post-wave-2 / Melbourne)*
- **N3** Engine conformance suite hardening so N2-class adapters have a real gate (also covers the
  server-unit socket flake seen 2026-07-12). *(grok-4.5-high)*

### Track R — Relay: scan once, reach the Mac from anywhere (founder priority)
Current state (shipped 2026-07-06): QR pairing with per-device rotating secrets over
LAN + MagicDNS + Funnel. Gap: the paths are captured at scan time and don't self-heal — the goal
is **one scan, then wifi/cellular/any network just works**.
- **R1** Endpoint ladder + auto-failover: the QR carries a bundle `{lan[], tailnet, funnel,
  deviceSecret}`; the app health-checks and races paths (LAN → tailnet → funnel), re-elects on
  network change (NetInfo), and refreshes the ladder from `GET /api/relay/endpoints` over any
  working path — so endpoints can change forever after one scan. Signed connection ticket so path
  switches never re-auth. *(GPT server + Opus RN)*
- **R2** Funnel watchdog + relay health surface: daemon keeps the funnel alive (re-enable on drop,
  alert to Inbox when public path is down); Settings shows per-path latency/status (the drawer
  footer's "Tailscale 12ms" becomes real). *(GPT)*
- **R3 (later)** Optional cloud relay fallback (tiny WebSocket broker) for tailnet-hostile
  networks; explicitly out of the pre-flight window.

### Track Q — Quality/platform (cursor lead)
- **Q1** Engine identity: pi slot presented as "Nuncio Engine" where appropriate (docs/pi-engine.md
  open decision 4) — picker label, settings copy. *(composer-2.5-fast)*
- **Q2** Docs sync: pi-engine.md statuses, AGENTS/README tables after each merge wave.
  *(composer-2.5-fast)*

## Waves

| Wave | Lanes (parallel) | Teams |
|---|---|---|
| **1** (day 1) | M1+M2 · E1 · G1 · N1 · M5 | Opus · GPT · GPT · GPT · composer |
| **2** (day 2–3) | **R1 relay ladder** · M3 · E2 · E3 · **E4 Simulator Panel** · G2 Envoys · N3 · Q1+Q2 | GPT+Opus · GPT+Opus · Opus · GPT · GPT+Opus · GPT · grok-high · composer |
| **3** (pre-flight) | **R2 funnel watchdog** · **M6 lock-screen answers** · M4 · E6 phone preview · G3 | GPT · GPT+Opus · Opus · GPT+Opus · GPT |
| **4** (Melbourne) | M8 diff review · M9 ship-from-phone · G4 · M7 Live Activity · G5 · E5 | Opus+Sonnet · GPT+Opus · GPT · Opus · GPT · GPT |

Trip-critical subset: **R1, R2, M1–M3, M6, E1–E3, E6** — everything else degrades to wave 4.

Wave-1 conflict map: M-lanes live in `apps/mobile`; E1 in new `apps/server/src/evidence` +
`events.types.ts` (sole owner this wave); G1 in `apps/server/src/agents/pi-engine`; N1 in
models/pi provider catalog surfaces — disjoint. Three concurrent codex missions is the tested
ceiling today; M-lanes ride Opus so wave 1 fits.

## Risks

- Dev velocity: parallel sessions ship continuously — every lane merges origin/dev pre-PR;
  orchestrator owns conflict resolution (precedent: PR #72).
- Same-model review bias: builder and reviewer are both 5.6-sol → adversarial review runs in a
  fresh session with an explicit refute-first prompt; Opus lanes get codex review (cross-model).
- Codex sandbox: server unit suites and anything needing network/simulator run at the orchestrator.
- Trip-critical subset if time runs short: M1–M3, E1–E3. Everything else degrades to wave 4.

## Wave 1 execution log (2026-07-12)

Branches off `dev` (4aead007). Review = grok-4.5 cross-model (builder is GPT sol / Opus, so reviewer never shares the builder's model). Orchestrator runs full suites (codex sandbox can't bind sockets).

| Lane | Branch | Build | Review findings | Status |
|---|---|---|---|---|
| M5 | feat/mobile-polish | composer-2.5-fast | grok: 1 blocker (waiting-state gated on RUNNING) + 1 minor (mono status dots) — fixed | **MERGED #74 → e589c359** |
| M1+M2 | feat/mobile-transcript-question-plan | Opus | grok: 2 blockers + 4 minors — all fixed | **MERGED #75** |
| E1 | feat/evidence-service | GPT sol | grok deep tier: 3 blockers + minors → fixed → grok blocker-closure ALL CLOSED | **MERGED #77** |
| G1 | feat/engine-context | GPT sol | grok: 2 blockers + minors → fixed (CI needed a changeset) | **MERGED #76** |
| N1 | feat/pi-multi-provider | GPT sol | grok: 1 medium + 1 low → fixed; rebased post-G1 | **MERGED #78** |

Merge-order note: G1 and N1 both touch pi-agent.provider.ts → merged G1 first, N1 rebased.

**WAVE 1 COMPLETE 2026-07-13 — all 5 lanes on dev (#74 #75 #77 #76 #78).** Process validated: build → orchestrator full-suite verify → cross-model grok review → fix round → (E1 security: + grok blocker-closure) → merged-state verify → PR → CI → merge. Every lane had real review findings caught and fixed. All /tmp clones + worktrees cleaned.

## Council (Fable) ruling — 2026-07-13

Protocol: Fable = council/final-judgment, consulted BEFORE delegating; never a worker; high/xhigh only. Security-relevant lanes go straight to GPT sol (never routed through Fable).

Wave-1 close:
- E1 was fixed same-model (GPT checks GPT) → added a grok blocker-closure pass (reviewer that raised them): ALL CLOSED. Merged as PR #77.
- Verify MERGED state not branch state (base moves as lanes land); after G1 merges, update N1 + re-green CI before merging.
- `evidence_captured` is a one-way-door event schema — shape frozen; capture failure must be fire-and-forget (never fails the task it documents).

Wave 2 — organizing principle: **physical-presence work before Thu; Melbourne-doable after.** Cut E4 (Simulator Panel) + G2 (Envoys) to Melbourne. Open: R1 relay server (GPT-1, the lane), M3 push **with an hour-1 device-push spike** (GPT-2), R2 funnel watchdog pulled up + E3 simctl/Maestro (GPT-3), E2 then R1-RN then M3-deeplink (Opus), N3+Q1/Q2 (cursor). E6 opens when R1 server merges. **Highest leverage = R1**: once reachability is solid, the phone browser opens the nuncio WEB UI through the relay → whole cockpit on phone with zero new RN code (guaranteed fallback).

Structural risks with NO current lane (need founder/ops action):
1. **Apple push provisioning has wall-clock lead time** — remote push isn't in Expo Go; M3/M6 need APNs key + entitlement + physical-device dev build. Run the spike ~Sun; if it stalls, know 4 days out not Wednesday.
2. **R1 must be backward-compatible** (old scan bundles keep working) + **freeze relay ~24h before departure** — a Wednesday relay regression = flying with less than today.
3. **Unattended-Mac ops checklist** (not code): pmset/caffeinate lid-closed, launchd daemon keepalive, auto-restart after power loss, auto-login, funnel persistence, **Tailscale node-key expiry** (silent tailnet death mid-trip). Named pre-flight item.
4. **Wednesday dress rehearsal** is the real gate: phone on cellular, Mac lid closed, full loop assign→push→answer→see→merge. Nothing ships Thu morning.
5. Funnel = JSON control-plane only; prefer tailnet (Tailscale app on phone) for heavy streams (E6/serve-sim). Funnel is no-VPN fallback.
6. Check codex/cursor/gh token lifetimes before leaving (orchestrating from Melbourne depends on them; glab already open).
