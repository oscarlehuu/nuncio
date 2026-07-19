# Real-run eval — Engine policy shell (phase 03) + compaction layer (phase 06)

Date: 2026-07-19. Machine: user's Mac (Seatbelt available, cliproxyapi up, Codex CLI 0.144.1 logged in).
Branches under test: `cursor/engine-policy-shell-a4e5` (PR #124) + `cursor/engine-compaction-a4e5` (PR #125).
Server: real daemon on :3077, isolated `NUNCIO_DATA_DIR=/tmp/nuncio-eval/data`.

## Phase 03 — Builder A/B: Nuncio Engine + sandboxed shell vs Codex

Task (identical for both arms): fixture repo `slugify-fixture` (bun project, 3 of 4 specs failing);
objective "make all four specs pass by improving src/slugify.ts only; run bun test yourself before
submitting". Same Foreman + Reviewer (`pi cliproxyapi:claude-sonnet-4-6`), same frozen
`verifyCommand: bun test`, `maxVerifyRetries: 2`. Real Crew runs over REST, real worktrees.

| Metric | Builder = pi `cliproxyapi:claude-opus-4-8` (+ sandboxed bash) | Builder = codex `gpt-5.6-sol` |
|---|---|---|
| Outcome | **SUCCEEDED** (DONE) | **SUCCEEDED** (DONE) |
| First-verify green | ✅ yes (0 retries) | ✅ yes (0 retries) |
| Build phase duration | **18s** | 51s |
| Whole run | 3.1 min (foreman plan turn was 138s — same model took 13s in arm 2; provider latency variance, not builder) | 1.8 min |
| Builder self-test before submit | **observed in transcript**: `read×2 → edit → bash "bun test 2>&1" (green) → submit_build` — the sandboxed shell was used exactly as designed | opaque: Codex runs commands inside the app-server; the shared event log shows only deltas + final message, so self-testing cannot be counted from the transcript |
| Review | passed, no blockers | passed, no blockers |

**Verdict (n=1 per arm, small task):** the Nuncio Engine Builder with the sandboxed shell is
**competitive with Codex** — both landed green on the first verify; the pi Builder's build phase was
faster on this task and, unlike Codex, its self-verification is *visible and auditable* in the
transcript (`bash "bun test"` with output, run under Seatbelt: network denied, `.git`/`.nuncio`
read-only). One task is a smoke-grade signal, not a statistical one; the harness + method are now
reproducible for a bigger set.

**Bug found (pre-existing, not from these PRs):** first Codex arm with `codex:gpt-5.5` died in BUILD
with `provider_unavailable` — the user's `~/.codex/config.toml` sets `model_reasoning_effort = "max"`,
which the app-server applies to the Crew member turn and gpt-5.5 rejects
(`Invalid value: 'max'. Supported: none…xhigh`). Nuncio passes no effort for Crew members, so the CLI
config leaks in. Follow-up: pin a safe default effort per Codex turn (or surface binding-level
effort — the planned per-phase-effort backlog item). Workaround used: `codex:gpt-5.6-sol`.

## Phase 06 — Compaction: real round-trip + ON/OFF probe

Vehicle: new gated integration spec `test/integration/pi-compaction.integration.spec.ts` (real Pi
machinery, real cliproxyapi summarizer, ~1 small live turn + 1 probe turn per path). Session model
`cliproxyapi:claude-sonnet-4-6`. Seed: Nuncio event log gets a 3-item plan (one `in_progress`) and a
FAILED `verify_result` (`bun run gate:frobnicator`); the Pi conversation gets one steer constraint
("keep the relay behind the NUNCIO_FROBNICATE flag") followed by ~70K estimated tokens of filler
turns; then `session.compact()` runs Pi's real compaction machinery.

| Check after compaction | Layer **ON** | Layer **OFF** (Pi default) |
|---|---|---|
| Compaction produced by | Nuncio hook (`fromExtension: true`) | Pi summarizer |
| Plan verbatim in new context | ✅ `- [~] wire the frobnicator relay into the composer drawer` | ❌ absent (plan lives in Nuncio's log, which Pi's summarizer never sees) |
| Failed verify verbatim | ✅ `Verify: FAILED (exit 1) — bun run gate:frobnicator` + failing spec tail | ❌ absent |
| Steer constraint | ✅ verbatim in "Recent user instructions" **and** in narrative | ⚠️ paraphrased into the summary (survived this time — a well-behaved summarizer, not a guarantee) |
| Durable-history pointer | ✅ `read_session_history` note appended | ❌ n/a |
| **Continuation probe** ("which plan item is in progress / what verify command failed / which flag?") | **3/3 correct**, answered with the literal values | **1/3** — flag ✅; plan item ❌ ("awaiting further steps"); verify ❌ ("no verify failure appears in the current context") |

**Verdict:** the layer does exactly its job — Nuncio-level state (plan, verify) that Pi's default
compaction *cannot* preserve (it lives outside Pi's conversation) survives verbatim and the session
keeps working from it, at the cost of one cheap-model summarize call. The narrative itself also
carried the constraints in both paths, so the differentiator is precisely the harness-owned state.
Recommendation: keep `NUNCIO_ENGINE_COMPACTION` opt-in until a multi-session eval on recorded real
sessions repeats this margin, then flip the default (plan phase 06 tail).

## Reproduce

```bash
# Phase 06 (gated on ~/.pi/agent/auth.json; a few small LLM calls):
cd apps/server && bun test test/integration/pi-compaction.integration.spec.ts

# Phase 03: boot a daemon with NUNCIO_CODEX_BIN set, create the two profiles via
# POST /api/crew/profiles (bindings above, verifyCommand "bun test"), POST /api/crew/tasks
# against a fixture repo, and read /api/crew-runs/:id/events for the timeline.
```

## Unresolved

- n=1 per arm; a representative task set from recorded sessions (with the user) is still the
  acceptance bar for flipping any defaults.
- Codex Builder self-testing is invisible in the shared transcript (app-server internal); consider
  mapping Codex command items to shared `tool_start`/`tool_end` for parity.
- Codex + Crew inherits `model_reasoning_effort` from the user's CLI config; a model that rejects
  that effort bricks the member turn (pre-existing bug, fix separately).
