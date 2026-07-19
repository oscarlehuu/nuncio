# Phase 01 — Pi sandboxed shell tool (Track A)

## Context links

- `apps/server/src/agents/providers/pi-runtime-policy.ts` — policy toolset today: read/edit/write/
  grep/ls, **no bash** ("host-shell confinement plus disabled network is unprovable").
- `apps/server/src/crew/crew-command-sandbox.ts` — proven Seatbelt/bwrap launch builder
  (network-deny, workspace-write confinement, `.git` write-denied, probe + fail-closed).
- `apps/server/src/agents/agent-runtime-policy.ts` — canonical policy + workspace guards.
- Locked decisions 1–3 in [plan.md](plan.md).

## Overview

Priority: high (biggest Crew capability jump). Give every Pi runtime-policy session a `bash` tool.
When a sandbox backend is available, every command runs wrapped in a Seatbelt/bwrap profile scoped
to the policy workspace; otherwise a plain fallback runs with the degradation announced. Nuncio owns
the tool (SDK `customTools` take precedence), so no reliance on Pi bash internals.

## Requirements

- Sandboxed mode enforces: deny network, writes confined to `workspaceRoot` (+ temp dir), `.git`
  write-denied. Read-only policies do NOT get bash (nothing read-only about a shell).
- `NUNCIO_ENGINE_POLICY_SHELL=auto|sandboxed-only|off`, default `auto` (settings-registry entry,
  lands with the Engine settings group in phase 05; env works immediately).
  - `auto`: sandbox when available, plain fallback otherwise (fallback announced in tool
    description + runtime instructions as advisory confinement).
  - `sandboxed-only`: no sandbox → no bash tool (pre-user-decision behavior).
  - `off`: never add bash.
- Output bounded (reuse existing payload truncation limits); command timeout; kill on dispose.
- Shared-first: the launch builder is generic (not Crew-named); Crew verifier keeps a thin wrapper.

## Related code files

- **Create:** `apps/server/src/agents/runtime-command-sandbox.ts` — extract the generic
  profile/launch core out of `crew-command-sandbox.ts` (verifier-only options — `dependencyRoot`,
  `sourceRoot`, env scrubbing — stay in the crew wrapper). Pure refactor first: crew specs stay
  green unchanged.
- **Create:** `apps/server/src/agents/tools/policy-shell-tool.ts` — the `bash` runtime tool:
  `execute(command)` → `Bun.spawn(launch.argv)` (or plain `/bin/sh -c` fallback), stdout/stderr
  merged, truncated, exit code surfaced.
- **Edit:** `apps/server/src/agents/providers/pi-runtime-policy.ts` — `workspace-write` policies
  add `'bash'` to `toolNames` + the custom tool to `customTools` per the shell mode.
- **Tests:** `apps/server/test/unit/agents/policy-shell-tool.spec.ts`,
  extend `test/unit/agents/pi-runtime-policy.spec.ts`; gated integration in
  `test/integration/pi-agent.integration.spec.ts` (real sandbox: `curl` denied, write outside
  workspace denied, `bun test` inside workspace succeeds).

## Implementation steps (TDD)

1. Red: spec the extraction seam — generic launch builder produces the same argv/profile the crew
   verifier spec already pins; crew wrapper delegates. Green: extract.
2. Red: policy-shell-tool specs — sandboxed argv when available; plain fallback under `auto`
   without sandbox; absent under `sandboxed-only` without sandbox; absent for read-only policy;
   absent when `off`; output truncation; nonzero exit surfaced not thrown.
3. Green: implement tool; wire into `buildPiRuntimePolicyOptions`.
4. Update runtime instructions so the model knows the enforcement level it is under.
5. Gated integration proof (macOS Seatbelt): network deny + confinement + real test run.

## Todo

- [ ] Extract generic sandbox launch module (crew specs stay green)
- [ ] policy-shell-tool + specs (all modes)
- [ ] pi-runtime-policy wiring + specs
- [ ] Gated integration proof
- [ ] Changeset (minor): "Crew Builders and policy sessions on the Nuncio Engine can now run
      shell commands in a Nuncio-enforced sandbox."

## Risks

- Sandbox latency per command → acceptable (verifier already pays it); document.
- Command evades string-level expectations → irrelevant: enforcement is the OS sandbox, not
  parsing. Unsandboxed fallback is the accepted (announced) exception per locked decision 3.
