# Nuncio Engine (Pi Harness)

**Status:** approved direction; loading recipe spike-verified 2026-07-11 against
`@earendil-works/pi-coding-agent` 0.80.6. **Step 0** (extension allowlist) shipped 2026-07-11;
**Step 1** (`nuncio-context` injection) shipped on `dev`. **Multi-provider model catalog**
(auth-truthful `ModelRegistry` groups) and **provider-neutral evidence capture** (headless Chrome
screenshots bound to workspace HEAD) also shipped on `dev`. Step 2 (in-repo extension factories)
remains planned.
**Companions:** [Crew workspace harness](crew-workspace-harness.md),
[CrewRun authority and state machine](crew-run-authority-and-state-machine.md).

## What it is

Nuncio Engine is Nuncio's own agent harness, built **on** Pi — never from scratch, never a fork.
Pi keeps owning the inner model loop (providers, streaming, tool execution, session files).
Nuncio Engine claims the four questions above that loop:

| Question | Today | Nuncio Engine seam |
|---|---|---|
| What does the agent **know**? | Pi default system prompt | `ResourceLoader.systemPrompt/appendSystemPrompt`, `before_agent_start` (per-turn replace) |
| What can it **do**? | Pi generic tools + whatever `.pi/` discovery finds | `extensionFactories` + `registerTool` (nuncio tool belt) |
| What is it **blocked from**? | nothing | `tool_call` handlers (verify gate, allowlists) |
| What does it **remember**? | Pi default compaction | `session_before_compact` + exported compaction module |

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
- **Step 2 — replace allowlisted paths with in-repo factories** once foreman/subagent are ported
  from `~/.pi/agent/extensions/` into the repo; deny-by-default remains unchanged.

Extension roadmap after that, in order:

1. `nuncio-tools` — tool belt over tasks/attention/artifacts/forge, building on the existing
   `AgentRuntimeTools`/`buildPiCustomTools` wiring.
2. `verify-gate` — `tool_call` hook: UI-touching diffs cannot report done without green verify +
   evidence (see below).
3. Ported `foreman`/`subagent` (inner fan-out), custom compaction, `additionalSkillPaths`.

Code layout: `apps/server/src/agents/pi-engine/` — one kebab-case file per extension, under ~200
lines, independently disableable. `pi-agent.provider.ts` upgrades in place to build the loader.

## Evidence capture (before/after proof)

**Status on `dev`:** layer 1 (provider-neutral capture service) shipped — see
`apps/server/src/evidence/evidence-capture.service.ts` and the session evidence API. Layers 2–3
(Engine tool belt + done gate) remain on the Engine roadmap below.

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
