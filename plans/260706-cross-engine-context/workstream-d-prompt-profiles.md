# Workstream D — Prompt Profiles & Behavioral Eval Suite

> **Execution amendments (2026-07-07):** D1–D5 shipped. Deltas: profile section wrappers are
> capped at 2048B serialized at parse; the digest clamp always re-appends the action sentence;
> contextFileName is bare-filename + containment guarded; the loader busts on settings
> onChange. The eval runner writes ONE aggregated report per (engine, model). `--stamp-profile`
> emits a paste-ready evalScore block (hermetic daemons are gone by stamp time — it does not
> write the DB override itself). D6 remains unbuilt (rung-2 gated).

Answers "how do we adapt prompts per engine/model, including ones that don't exist yet, without
it being a manual craft each time." Structure: prompt idiom becomes **data** (D1), rendering
consults it (D2), a **hermetic eval harness** (D3) runs the full task set
([eval-suite.md](eval-suite.md)) to score any (engine, model, profile) triple, a compare
command turns prompt changes into measured deltas (D5), and an onboarding pipeline
semi-automates new-model bring-up (D6).

The founder's remaining manual jobs, by design: curating the eval task set, and approving
profiles. Writing/tuning prompt templates stops being one.

---

## D1 — Prompt profiles as data

**Goal.** Every engine-specific prompting decision lives in a versioned data file, never in
adapter code.

**Storage decision (from plan.md table): repo defaults + DB overrides.**
- Repo: `apps/server/prompt-profiles/<provider>.md` (one per provider; model-specific variants
  as `<provider>--<model-slug>.md`). Reviewable in PRs, shipped with the app.
- DB override: settings key `NUNCIO_PROMPT_PROFILE_<PROVIDER>` holding a full profile document —
  wins over the repo file when present (lets the founder hotfix without a release; the
  onboarding pipeline writes its candidates here before they graduate to repo files).

**Format** — markdown with YAML frontmatter (matches the skills/docs idiom already in use):

```markdown
---
provider: claude            # AgentProvider.id this applies to
modelPattern: "*"           # glob against model id; most-specific match wins
version: 3
status: active              # draft | active | retired
contextFileName: CLAUDE.local.md   # B4 consumer; omit if engine has none
evalScore: { passRate: 0.88, suiteVersion: 2, at: 2026-07-06 }   # stamped by D5, informational
---

## brief-wrapper
<!-- optional mustache-lite wrapper around the rendered handoff brief; `{{content}}` slot -->

## facts-wrapper
## digest-wrapper
## tools-preamble
<!-- overrides the C1 systemPromptAppend paragraph -->

## idioms
<!-- freeform notes: known quirks, do/don't list. Injected nowhere; read by humans and by the
     D6 distill step as prior context. -->
```

**Loader** — `apps/server/src/prompts/prompt-profile.loader.ts`: parse frontmatter + named
sections; validate (`provider` required, `version` integer, unknown sections warn-not-fail so
old daemons tolerate newer profiles); resolve `(provider, model)` → profile with precedence
DB-override > model-specific repo file > provider repo file > built-in empty profile (all
wrappers pass-through). Cache per process; `bustCache()` alongside the provider registry's.

**Non-goals.** Profiles do not replace or modify the engine's own system prompt — engines are
harnesses with vendor-owned system prompts (that is their job); profiles only shape what nuncio
appends/wraps.

**Tests.** Loader spec: precedence order (all four levels), glob specificity
(`claude--opus-*` beats `*`), malformed frontmatter → skipped with warning + fallback,
pass-through empty profile behaves identically to "no profile" byte-for-byte.

**Acceptance.** Deleting every profile file changes zero bytes of any composed prompt
(pass-through invariant) — proven by a dedicated spec.

---

## D2 — Profile-aware rendering

**Goal.** One canonical artifact, N engine-idiomatic renderings — the only place per-engine
prompt shape exists.

**Wiring.** `composeSessionPreamble` (B2) and `renderOutcomeDigest` (A5) gain an optional
`profile` argument. Each wrapper section, when present, wraps the canonical markdown:
`wrapper.replace('{{content}}', rendered)`. No other templating (no conditionals, no loops —
if a wrapper needs logic, the canonical renderer is the right place, keeping profiles dumb
data). C1's `systemPromptAppend` consults `tools-preamble` the same way.

Resolution point: `TasksService.execute()` / `SessionsService.create()` already know
`(provider, model)` before composing — resolve the profile there, pass it down. **No profile
access anywhere inside provider adapters** (they receive finished strings, preserving ADR-004).

**Tests.** Wrapper application spec: wrapper present/absent per section; `{{content}}` appears
twice in a wrapper → both replaced; wrapper without slot → content appended after wrapper text +
warning (fail-open). End-to-end: same brief composed for two providers with different wrappers
yields the expected two strings.

**Acceptance.** Switching a task's provider changes only wrapper bytes in the composed prompt,
never canonical content.

---

## D3 — Behavioral eval harness

**Goal.** `bun run eval:engines` scores any installed engine against the full task set,
hermetically, unattended.

**Architecture** — `scripts/engine-eval.mjs` (orchestrator) + `eval/` directory at repo root:

```
eval/
  tasks/<task-id>.json          # task definitions (schema below)
  fixtures/<fixture-id>/setup.mjs   # builds a throwaway git repo in a tmp dir
  checks/<task-id>.mjs          # runner-side hidden assertions (see two-layer note)
  reports/                      # gitignored output
```

**Task definition schema** (`eval/tasks/*.json`):

```json
{ "id": "fix-failing-unit-test",
  "title": "…",
  "fixture": "ts-lib-broken-slugify",
  "prompt": "…exact prompt text, may reference {{factStore}} etc…",
  "setup": { "facts": [...], "brief": {...} },
  "verifyCommand": "bun test",
  "timeoutMs": 300000,
  "tags": ["mechanical"],
  "expect": { "verifyPassed": true } }
```

**Run mechanics per (engine, model, task):**
1. Fixture setup builds a fresh tmp git repo (`setup.mjs` is deterministic: fixed file
   contents, `git init` + one commit with a fixed author/date — no `Date.now()` content).
2. A **hermetic daemon** boots with `NUNCIO_DATA_DIR=<tmp>`, ephemeral port,
   `NUNCIO_VERIFY_COMMAND` from the task — same recipe as `scripts/smoke-ui.mjs` (reuse its
   stack-boot helper; extract to `scripts/lib/hermetic-stack.mjs` if currently inline).
3. Enqueue one task via `POST /api/tasks` with `projectPath=<fixture>`, provider/model under
   test, `contextBrief` from `setup.brief`, facts pre-seeded via the B1 API when
   `setup.facts` present.
4. Await terminal status (poll `GET /api/tasks`, task `timeoutMs` cap → scored `timeout`).
5. Score = `verify_result` (visible layer) **AND** `checks/<task-id>.mjs` (hidden layer),
   which receives `{ fixtureDir, taskDto, sessionEvents }` and returns
   `{ pass: boolean, notes: string[] }`.
6. Teardown: daemon kill, tmp dirs removed; every run is independent (no shared state between
   tasks — slower, hermetic, worth it).

**Two-layer verification (anti-gaming, load-bearing).** The in-repo verify command is visible
to the engine — that's legitimate guidance (principle 4). Assertions the engine must not
optimize against (e.g. "did not modify the forbidden file", "did not fabricate the artifact",
"actually ran the migration rather than editing the snapshot") live runner-side in `checks/`,
outside the fixture, invisible to the engine. Every task in eval-suite.md declares both layers
explicitly.

**Concurrency & cost.** Serial per engine v1 (provider CLIs contend on auth/subprocesses);
`--tasks`, `--engines`, `--models` filters for cheap partial runs. Token/cost capture: record
wall-time + event counts now; wire real token counts when rung-4 observability lands (field
reserved in the report schema as `tokens: null`).

**Report** — `eval/reports/<timestamp>-<engine>-<model>-p<profileVersion>.json`:
`{ suiteVersion, engine, model, profileVersion, results: [{ taskId, pass, verifyPassed,
hiddenPassed, durationMs, rounds, notes }], passRate }` + a rendered markdown table to stdout.

**Engine skipping.** `isAvailable()` false → engine reported as `skipped: not installed`
(explicit row, per ADR-011 guardrail — silence is what we're avoiding).

**Tests for the harness itself.** Mock-provider end-to-end: one synthetic eval task the mock
can "solve" (its scripted output writes the expected file via a scripted tool call) proves the
whole loop — fixture, daemon, enqueue, both check layers, report shape. Fixture determinism
spec: running `setup.mjs` twice yields identical `git rev-parse HEAD`.

**Acceptance.** Program done-when #3: full suite, all installed engines, twice, identical
fixture states, unattended.

---

## D5 — Baseline & regression compare

**Goal.** Prompt/profile changes become measured deltas; new engine versions get a regression
gate.

**Pieces.**
- `bun run eval:engines -- --baseline` copies the report to
  `eval/baselines/<engine>-<model>.json` (these ARE committed — small JSON, the whole point is
  diffable history).
- `scripts/engine-eval-compare.mjs`: `bun run eval:compare -- <reportA> <reportB>` → per-task
  table: `pass→fail` (regression, exit 1), `fail→pass` (improvement), duration deltas
  > 50%. Also `--against-baseline <engine>` shorthand.
- Profile stamping: on a run where every task completed (no skips/timeouts from infra), offer
  `--stamp-profile` to write `evalScore` into the DB-override profile frontmatter (never
  auto-edits repo files — that graduation is a PR the founder makes).

**Tests.** Compare-script spec over two fixture reports: regression detection + exit code,
improvement listing, mismatched suiteVersion → hard error (never compare across suite
versions).

**Acceptance.** Program done-when #4: a one-line profile edit shows up as a signed delta in
the compare output.

---

## D6 — Model onboarding pipeline (semi-automatic)

**Goal.** New model/engine drops → hours to a measured, founder-approved profile, not days of
hand-tuning. Full automation (the overnight loop) is gated on rung-2 loop primitives; this
ships as a driven checklist where every step is already a command.

**Steps (encoded in `scripts/engine-onboard.mjs` as an interactive runner):**

1. **Distill** — founder pastes the vendor's prompting-guide / release-notes URLs. The script
   enqueues a nuncio task (any strong installed engine) with a fixed distill prompt — itself
   stored as `apps/server/prompt-profiles/_meta/distill.md` so it is versioned data too —
   producing a draft profile document (frontmatter `status: draft`) written to the DB override
   slot. *Nuncio never calls a model API; the distiller is an ordinary session (guardrail).*
2. **Baseline** — `eval:engines --engines <new> ` with the built-in pass-through profile.
   Establishes floor + surfaces hard failures (auth, protocol) before any tuning.
3. **Variants** — the script enqueues K (default 3) tasks on a strong engine, each given: the
   draft profile, the baseline report's failing-task briefs, and the variant prompt (also in
   `_meta/`), asking for one revised profile each with a stated hypothesis per change.
4. **Score** — run the suite once per variant profile (`--profile-override <file>`);
   compare-all table vs baseline.
5. **Approve** — founder picks (or hand-merges) the winner; script sets `status: active` in
   the DB override and prints the diff to graduate into a repo file via normal PR.

**Overfit guard.** The suite is small; K variants scored once each is search, not training —
but still: the compare table flags any variant whose wins are concentrated in a single tag
group (suspicious specialization), and `idioms` changes (human notes) are surfaced separately
from wrapper changes (mechanical). Growing the task set (E-suite additions) is the real
defense; noted as a standing curation duty in eval-suite.md.

**Tests.** The `_meta` prompts are data — no unit tests; the script gets a dry-run mode spec
(steps print, nothing enqueues). Pipeline correctness is proven by dogfood, not CI.

**Acceptance.** Next real model release on an existing engine: pipeline run end-to-end, active
profile within one sitting, baseline + winner reports committed.
