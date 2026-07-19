# Nuncio Engine — policy shell + compaction layer

Grounding: origin/dev @ `7b3fa60a` (PR #122 merged: engine rail, gate-integrity, capture_evidence,
eval:extract). Companion studies: `plans/260718-nuncio-engine-harness-study/harness-gap-study.md`
and the 2026-07-19 compaction comparison (Pi 0.80.10 vs `openai/codex` vs `xai-org/grok-build`).

## Goal

1. **Track A — shell:** a Pi (Nuncio Engine) session under an explicit runtime policy gets a `bash`
   tool — sandboxed (Seatbelt/bwrap, network-deny + workspace-write confinement) whenever a sandbox
   backend is available — so a Crew Builder on the Engine can run tests/build before submitting
   instead of coding blind and burning verify retries.
2. **Track B — compaction:** an Engine session can compact any number of times without losing plan
   state, latest verify result, open chips, repro-gate state, or recent user steers — all preserved
   **verbatim by the harness**, never delegated to the summarizer (Grok Build skeleton on Pi's
   `session_before_compact` seam).

## Locked decisions (user, 2026-07-19)

1. Shell is **Pi-only** (we are building the Nuncio Engine; other engines can adopt the shared
   sandbox module later if ever wanted).
2. Shell applies to **all runtime-policy sessions**, not just Crew Builder (Crew is first consumer).
3. Shell **exists even without a sandbox backend** — sandboxed when available, plain fallback
   otherwise. Setting `NUNCIO_ENGINE_POLICY_SHELL=auto|sandboxed-only|off` (default `auto`) lets
   self-hosters tighten. Crew is unaffected: Crew already refuses to run without the verifier
   sandbox, so Crew members always get the enforced kind. Unsandboxed fallback is announced in the
   tool description/runtime instructions (confinement advisory, not enforced) — never silently.
4. **Gate-integrity ships with shell in the same PR** (rail + guard load into policy sessions;
   `.nuncio/**` write exclusion also lands in the shared runtime write guard).
5. Evidence pairing → Review gate is **deferred until after Track B**.
6. **Nuncio Engine settings group** in Settings: shell mode, gate guard, compaction toggle +
   compaction model (per-phase thinking effort rides the same group later — backlog).
7. **Eval replay is the acceptance gate of Track A** (Builder=codex vs Builder=pi-with-shell).
8. Compaction defaults (accepted recommendations): summarizer = `cliproxyapi:claude-sonnet-4-6`;
   verbatim recent-user-message budget ≈ 4K tokens; survivors v1 = plan + latest verify + open
   chips + repro-gate + nuncio-context facts; new `read_session_history` tool; ship **opt-in**,
   flip default only after eval wins (doc principle 4).

## Phases

| # | Phase | Track | Status |
|---|---|---|---|
| 1 | [Pi sandboxed shell tool](phase-01-pi-sandboxed-shell-tool.md) | A | planned |
| 2 | [Engine rail + gate guard into policy sessions](phase-02-engine-rail-into-policy-sessions.md) | A (same PR as 1) | planned |
| 3 | [Shell eval acceptance](phase-03-shell-eval-acceptance.md) | A | planned |
| 4 | [Compaction contract spec + survivors builder](phase-04-compaction-contract-and-survivors.md) | B | planned |
| 5 | [Compaction extension + Engine settings group](phase-05-compaction-extension.md) | B | planned |
| 6 | [Transcript pointer tool + integration/eval](phase-06-transcript-pointer-and-eval.md) | B | planned |

Ordering: 1→2→3 and 4→5→6 are internally sequential; the two tracks touch disjoint files
(A: `agents/providers/pi-runtime-policy.ts`, sandbox module, crew loader wiring; B: `pi-engine/`,
`sessions/domain/`) and may run in parallel worktrees from `dev`.

## Non-goals

- No Grok Build port (no full-replace, no input ladder, no two-pass prefire, no memory flush).
- No Claude/Codex shell work; no Crew workflow changes; no new FSM state or per-provider events.
- No default-on for compaction before the eval win.

## Success criteria

- Track A: Crew run with Builder=pi executes its own `bun test` under the sandbox and submits
  green; sandboxed bash denies network + out-of-workspace writes (gated integration proof);
  gate guard blocks `.nuncio/**` writes in policy sessions; eval A/B report exists.
- Track B: after a real compaction the survivors block is byte-identical to its source events
  (deterministic assert); extension failure falls back to Pi default compaction; contract spec
  pins the SDK hook surface; `bun run gate` green on every phase.
