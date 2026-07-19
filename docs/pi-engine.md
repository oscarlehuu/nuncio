# Nuncio Engine (Pi Harness)

**Status:** approved direction; loading recipe spike-verified 2026-07-11 against
`@earendil-works/pi-coding-agent` 0.80.6. **Step 0** (extension allowlist) shipped 2026-07-11;
**Step 1** (`nuncio-context` injection) shipped on `dev`. **Multi-provider model catalog**
(auth-truthful `ModelRegistry` groups) and **provider-neutral evidence capture** (headless Chrome
screenshots bound to workspace HEAD) also shipped on `dev`. **Extension rail + gate-integrity
hook, diff-aware verify + evidence layers 2–3, and the recorded-session eval extractor** shipped
2026-07-18. Step 2 (porting foreman/subagent into in-repo factories) remains planned.
**Companions:** [Crew workspace harness](crew-workspace-harness.md),
[CrewRun authority and state machine](crew-run-authority-and-state-machine.md).

## What it is

Nuncio Engine is Nuncio's own agent harness, built **on** Pi — never from scratch, never a fork.
Pi keeps owning the inner model loop (providers, streaming, tool execution, session files).
Nuncio Engine claims the four questions above that loop:

| Question | Today | Nuncio Engine seam |
|---|---|---|
| What does the agent **know**? | `nuncio-context` facts + HandoffBrief + external memories | `ResourceLoader.systemPrompt/appendSystemPrompt`, `before_agent_start` (per-turn replace) |
| What can it **do**? | engine tool belt (todo, AskUserQuestion, spawn_task, request_reproduction, read_external_memory, capture_evidence) | `extensionFactories` + `registerTool` (nuncio tool belt) |
| What is it **blocked from**? | editing its own `.nuncio` verify gate (gate-integrity `tool_call` hook) | `tool_call` handlers on the `nuncio-engine` rail |
| What does it **remember**? | Pi default compaction (still unclaimed) | `session_before_compact` + exported compaction module |

Why Pi gets this treatment and Claude/Codex do not: Claude Agent SDK and Codex app-server are
black-box vendor runtimes — Nuncio can only orchestrate their outer loop. Pi is the one runtime
where Nuncio can own the entire inner loop while staying multi-provider (Claude, GPT, Grok, and
anything Pi's registry supports). This resolves the Crew doc's open decision 5: **Pi stays, and is
upgraded in place** — `apps/server/src/agents/providers/pi-agent.provider.ts` evolves; no parallel
provider is added.

## Principles

1. **Own the seam, not the loop.** Everything lives at official extension points (loader options,
   extension hooks, tools). The day something needs a patch inside Pi is the day to redesign, not
   fork.
2. **Extensions-first, options-second, fork-never.** Intervention order: `createAgentSession`
   options → extension hooks → custom tools. 0.x semver: pin the version, smoke-test on bump.
3. **Each capability is one small, independently toggleable extension** — debuggable layer by
   layer.
4. **Evaluation is the gate.** Nuncio Engine must beat vanilla Pi on real Nuncio tasks (same model,
   same task set) or a layer does not ship.

## Boundary versus the Crew harness

| | Crew harness | Nuncio Engine |
|---|---|---|
| Layer | provider-neutral **outer** loop | Pi-slot **inner** loop |
| Owns | roles, task routing, shared workspace, gates, attention | context, tool belt, hooks, compaction of one provider |
| Applies to | every engine | Pi sessions only |

Engine specifics must never leak into shared session/task/UI layers (same rule the Crew doc sets
for Fable/Sol/Claude/Codex/Pi ids).

## Separation model: what stays in `.pi/`, what Nuncio owns

Do **not** rebuild Pi's config system. `~/.pi/agent` keeps the plumbing; Nuncio takes the
behavior axis only:

| Resource | Source | Change |
|---|---|---|
| `auth.json`, `models.json` | `~/.pi/agent` (shared with pi CLI) | none |
| settings, session files | Pi-managed, as today | none |
| **extensions** | `extensionFactories` — code in the nuncio repo | replaces `.pi/` discovery |
| **skills, system prompt** | loader options / repo | Nuncio decides |

The whole recipe is one object passed to `createAgentSession`:

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,                              // still ~/.pi/agent (settings resolution)
  noExtensions: true,                    // drop .pi/ extension discovery
  extensionFactories: nuncioEngineExtensions,  // in-repo, versioned with nuncio
  appendSystemPrompt: [projectFactsBlock, handoffBriefBlock],
});
await loader.reload({ resolveProjectTrust: async () => true });
const { session } = await pi.createAgentSession({ ..., resourceLoader: loader });
```

### Why this matters (baseline evidence, 2026-07-11)

Default discovery currently loads **19 global extensions** from `~/.pi/agent/extensions/` into
every Nuncio pi session (worktree-dash, session-namer, codex generate/edit, statusline, foreman,
claude-studio, grok suite ×6, continual-learning, AskUserQuestion, antigravity ×2, subagent,
pocketpi), plus the personal `~/.pi/agent/AGENTS.md` and a `continual-learning` skill. This class
of leak already produced a real bug: a global extension re-bound bash/read/edit/write to the wrong
cwd in worktree sessions, forcing the `buildPiCustomTools` workaround documented in
`pi-agent.provider.ts`.

Note: repo `AGENTS.md` and the personal `~/.pi/agent/AGENTS.md` still load as context files under
this recipe; use `noContextFiles`/`agentsFilesOverride` if the personal file should be excluded
(open decision 3).

## Spike results (verified against 0.80.2)

1. **`noExtensions: true` disables directory discovery only.** `extensionFactories` always load
   (`loadFinalExtensionSet` appends them unconditionally) and `additionalExtensionPaths` survive.
   Verified in `dist/core/resource-loader.js` and by running a probe factory: result was exactly
   one extension `<inline:1>` with its tool registered.
2. **ExtensionAPI surface available to factories:** `on`, `registerTool`, `registerCommand`,
   `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `getFlag`, `sendMessage`,
   `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel`, `exec`,
   `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel`,
   `getThinkingLevel`, `setThinkingLevel`, `registerProvider`, `unregisterProvider`, `events`.
3. **System prompt is controllable without hooks.** `appendSystemPrompt` lands in the loader
   (`getAppendSystemPrompt()`), `systemPrompt` replaces the base. Per-turn replacement also exists:
   `before_agent_start` handlers may return `{ systemPrompt }`; `before_provider_request` may
   replace the raw payload.
4. **Subscription auth already works headless.** `~/.pi/agent/auth.json` holds OAuth credentials
   (access/refresh/expires) for `anthropic` and `openai-codex`; the Nuncio daemon has been running
   Pi sessions against it daily. Claude/GPT via Nuncio Engine ride subscriptions, not per-token
   API billing.

## Adoption path

- **Step 0 — stop the leak. DONE (2026-07-11).** Nuncio Engine sessions now pass an engine
  `DefaultResourceLoader` with `noExtensions: true` + `additionalExtensionPaths` resolved from
  `PI_EXTENSION_ALLOWLIST` (`apps/server/src/agents/pi-engine/extension-allowlist.ts`) — chosen
  over a post-hoc `extensionsOverride` filter so denied extensions never even execute. Auth,
  models, settings, skills, and context files are untouched. Escape hatch: setting
  `PI_EXTENSION_DISCOVERY=full` restores pi default discovery. Verified: full unit suite plus a
  real-SDK session created with exactly the 12 allowlisted extensions.
- **Step 1 — first extension: `nuncio-context`. DONE (on `dev`).** `NuncioContextService`
  (`apps/server/src/agents/pi-engine/nuncio-context.ts`) injects bounded project facts +
  HandoffBrief via `appendSystemPrompt` on every Nuncio Engine session. Toggle via
  `NUNCIO_CONTEXT_INJECTION`; facts come from the shared context-facts store.
- **External agent memories. DONE.** Nuncio Engine reads project-scoped memory indexes from
  Claude Code and Codex CLI's existing stores without writing or copying them. The bounded
  informational index is appended after `nuncio-context`; `read_external_memory` opens an
  indexed item with a separate result cap. `PI_EXTERNAL_MEMORIES` gates each source and
  `PI_EXTERNAL_MEMORIES_MAX_BYTES` controls the index budget. Worktrees also match their owning
  repository path, and every filesystem read fails soft.
- **Extension rail + first `tool_call` hook. DONE (2026-07-18).** Solo Engine sessions carry the
  in-repo `nuncio-engine` inline extension (`apps/server/src/agents/pi-engine/engine-extension.ts`,
  loaded via `extensionFactories`, so it holds under both allowlist and full discovery). Its first
  hook is the **gate-integrity guard** (`gate-integrity.ts`, toggle `NUNCIO_ENGINE_GATE_GUARD`):
  edit/write into any `.nuncio/` directory is blocked pre-execution (lexical + symlink-realpath
  check), bash gets a best-effort advisory block, and the shared turn-diff classifier's
  `gate-protected` class is the durable backstop. This claims the "blocked from" quadrant.
  Since 2026-07-19 the rail also loads into **runtime-policy sessions** (Crew members), which stay
  otherwise hermetic; the shared policy write guard additionally refuses `.nuncio` targets for
  every engine's confined edit/write tools.
- **Sandboxed policy shell. DONE (2026-07-19).** Workspace-write policy sessions (Crew Builder)
  get a `bash` tool that runs every command through the shared OS sandbox
  (`agents/runtime-command-sandbox.ts` — the same Seatbelt/bubblewrap core the Crew verifier
  wraps): network denied, writes confined to the workspace, `.git` and `.nuncio` read-only. The
  Builder can finally run builds/tests before submitting instead of coding blind.
  `NUNCIO_ENGINE_POLICY_SHELL` = `auto` (default; without a sandbox backend the shell stays
  available but its description announces confinement is advisory — never silently) /
  `sandboxed-only` / `off`. Read-only policies never get a shell. Live-enforced by
  `policy-shell-tool.spec.ts` (real Seatbelt: outside-write denied, gate-write denied, network
  denied).
- **Verify gate + evidence layers 2–3. DONE (2026-07-18), provider-neutral where possible.**
  The done-gate is the session-layer post-turn verify loop (auto-steer, max rounds, futility stop),
  now diff-aware: `sessions/diff/turn-diff-classifier.ts` fingerprints the workspace so a no-change
  turn skips verify entirely, and `verify_start`/`verify_result` carry files/classes/fingerprint.
  A green verify on a `ui`-classified turn auto-captures after-evidence (known target →
  `NUNCIO_EVIDENCE_URL` fallback; fail-open). Solo Engine sessions also get the `capture_evidence`
  tool over the layer-1 service.
- **Eval mechanism (principle 4). DONE (2026-07-18).** `bun run eval:extract -- --session <id>`
  folds a recorded real session (durable event log) into a replayable `eval/tasks/*.json` with a
  `{ repo, baseSha }` pin; `eval:engines` clones the pinned SHA into a throwaway workspace and
  replays it, folding recorded human steers into the prompt. Extraction is curation — review the
  JSON (secrets, baseSha, verifyCommand) before committing.
- **Step 2 — replace allowlisted paths with in-repo factories** once foreman/subagent are ported
  from `~/.pi/agent/extensions/` into the repo; deny-by-default remains unchanged. New in-repo
  hooks now ride the shipped `nuncio-engine` rail.

Extension roadmap after that, in order:

1. `nuncio-tools` — tool belt over tasks/attention/artifacts/forge, building on the existing
   `AgentRuntimeTools`/`buildPiCustomTools` wiring.
2. Ported `foreman`/`subagent` (inner fan-out), custom compaction (`session_before_compact`),
   `additionalSkillPaths`.

Code layout: `apps/server/src/agents/pi-engine/` — one kebab-case file per extension, under ~200
lines, independently disableable. `pi-agent.provider.ts` upgrades in place to build the loader.

## Evidence capture (before/after proof)

**Status:** all three layers shipped. Layer 1 (provider-neutral capture service) — see
`apps/server/src/evidence/evidence-capture.service.ts` and the session evidence API. Layer 2 —
the `capture_evidence` engine tool (`pi-engine/capture-evidence-tool.ts`, solo sessions only).
Layer 3 — the green-verify auto-capture in `SessionsService.captureVerifyEvidence` (ui-classified
turns; known target → `NUNCIO_EVIDENCE_URL`; fail-open, never blocks the loop).

Principle: **harness-guaranteed, not model-hoped.** Three layers; layer 1 is provider-neutral and
ships independently of Nuncio Engine (all engines benefit — candidate for the mobile sprint).

1. **Capture service (nuncio layer).** Deterministic playwright-core against the dev server:
   *before* = baseline at task start, *after* = at completion. Artifact:
   `{ beforeRef, afterRef, route, viewport, workspaceHead }`, images via MediaStore, invalidated
   when the workspace head moves (same rule as verify/review results in the Crew doc).
2. **`capture_evidence` tool (Engine tool belt).** Some states must be *driven to* (click through
   a flow, open a dialog). The agent uses its browser skill to reach the state, then calls the
   tool; the harness captures deterministically and stores it in the right place.
3. **Done gate (Engine hook).** A diff touching web/mobile UI without an evidence pair cannot
   report done; fallback: the harness captures the default route itself.

Scope: web first (vite dev server); mobile via simulator screenshots (`xcrun simctl`) later;
screenshots first, recordings/GIF tier-2.

## Non-goals

- No raw model API harness inside Nuncio (unchanged from the Crew doc); Pi owns the model loop.
- No fork of Pi; no rebuild of Pi's config/auth/session plumbing.
- No `.nuncio/harness/` user-land directory yet — in-repo factories cover the only current user;
  add the directory when an out-of-repo extension actually needs a home.
- No Engine-specific concepts in shared session/task/UI layers.

## Open decisions

1. Timing: Engine step 0/1 versus the mobile sprint (Melbourne, ~2026-07-16); evidence layer 1 may
   land inside the sprint while Engine steps follow after.
2. Which global extensions get ported into the repo (foreman, subagent) versus staying personal
   `.pi/` CLI-land (grok suite, pocketpi, statusline).
3. Whether the personal `~/.pi/agent/AGENTS.md` should keep loading into Nuncio sessions.
4. **UI naming: RESOLVED — the engine picker and settings copy present the `pi` slot as
   "Nuncio Engine".** Internal id stays `pi`; only display strings changed.
5. Lifetime of the `.pi/` discovery compat toggle after step 2.
