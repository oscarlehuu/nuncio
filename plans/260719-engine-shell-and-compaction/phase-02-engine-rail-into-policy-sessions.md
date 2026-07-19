# Phase 02 — Engine rail + gate guard into policy sessions (Track A, same PR as phase 01)

## Context links

- `apps/server/src/agents/pi-engine/engine-extension.ts` — in-repo rail (`extensionFactories`),
  loads even under `noExtensions: true`. Today wired only into the **solo** loader
  (`createEngineResources`), NOT the policy loader.
- `apps/server/src/agents/pi-engine/gate-integrity.ts` — pure `.nuncio/**` guard (edit/write block,
  bash advisory block).
- `apps/server/src/agents/providers/pi-agent.provider.ts` — `policyResourceLoader` (hermetic:
  `noExtensions/noSkills/noContextFiles`, no `extensionFactories`).
- `apps/server/src/agents/agent-runtime-policy.ts` — `assertWritablePathWithinRuntimeWorkspace`
  (shared by Pi and Claude policy write paths).

## Overview

Priority: high — safety condition of phase 01. Once the Builder has a shell, nothing may let it
rewrite its own verify gate. Two layers, both provider-honest:

1. Load the `nuncio-engine` inline extension (gate guard hook) into `policyResourceLoader`, so Pi
   policy sessions get pre-execution `tool_call` blocking for `.nuncio/**` (including the new bash
   tool's advisory block).
2. Provider-neutral: exclude `.nuncio/**` from `assertWritablePathWithinRuntimeWorkspace` — one fix
   covers Pi **and** Claude policy edit/write tools (shared-first).

## Requirements

- Policy sessions keep their hermetic posture: ONLY the in-repo rail loads (no allowlist paths, no
  skills/context files). Existing hermetic specs must stay green.
- Reads of `.nuncio/**` stay allowed everywhere (Reviewer/Foreman read the gate; they must).
- The sandboxed bash from phase 01 additionally denies `.nuncio` writes at the profile level where
  expressible; the `tool_call` advisory block remains the cross-cutting layer.
- `NUNCIO_ENGINE_GATE_GUARD` continues to toggle the guard (existing setting).

## Related code files

- **Edit:** `apps/server/src/agents/providers/pi-agent.provider.ts` — pass `extensionFactories`
  (gate guard) into the policy loader.
- **Edit:** `apps/server/src/agents/agent-runtime-policy.ts` — `.nuncio` exclusion in the shared
  write guard.
- **Tests:** extend `test/unit/agents/pi-engine/gate-integrity.spec.ts` (policy-session load),
  `test/unit/agents/agent-runtime-policy.spec.ts` (write guard exclusion, reads unaffected),
  Claude policy spec row (Edit/Write into `.nuncio` denied).

## Implementation steps (TDD)

1. Red: shared write guard rejects `.nuncio/verify` (and symlink-into-gate) for workspace-write
   policies; allows reads; allows normal workspace writes. Green: exclusion.
2. Red: provider spec asserting the policy loader receives the engine extension factories when the
   gate guard is enabled, and stays hermetic otherwise. Green: wire-up.
3. Edge rows (state×event): steer mid-run unchanged (`runtime tools cannot change` guard already
   covers); recovery/resume rebuilds the same loader options.

## Todo

- [ ] Shared write-guard `.nuncio` exclusion + specs (Pi + Claude rows)
- [ ] Rail into policy loader + hermeticity specs
- [ ] Changeset shared with phase 01 PR

## Risks

- False-positive blocks on legit `.nuncio`-adjacent names (e.g. `foo.nuncio.ts`) — guard matches
  path *segments*, spec it explicitly.
