# Phase 2 — Provider-neutral runtime-policy safety gate

## Context links

- [Overview](plan.md)
- [ADR-004](../../docs/architecture-decisions.md#adr-004--provider-agnostic-agentprovider-contract-generic-first)
- [Crew runtime policy](../../docs/crew-workspace-harness.md#provider-runtime-policy-enforcement)

## Overview

**Priority:** Release blocker
**Status:** implemented and locally verified

Added explicit per-session policy to the shared Agent contract and adapters. Solo behavior remains
unchanged when policy is absent.

## Implemented contract

- `AgentRuntimePolicy = { filesystem, workspaceRoot, network: 'disabled' }`.
- Session persistence and every run/resume validate the policy against exact workspace and
  provider capability.
- Foreman/Reviewer require read-only; Builder requires workspace-write.
- Pi, Codex, and Claude advertise both policies only through adapter-backed enforcement.
- Unsupported enforcement rejects before prompt and makes Crew `needs_setup`.
- Runtime tools require trusted Crew registration plus matching security metadata.

## Provider mapping

- Pi omits shell and exposes only canonical path-confined file tools; Builder adds edit/write.
- Codex maps to app-server read-only/workspace-write sandbox policy, exact cwd/root, network off.
- Claude uses allowlisted tools plus canonical path authorization and `PreToolUse` enforcement.
- Writes outside the worktree and writes to `.git` metadata are denied.

## Architecture and files

`apps/server/src/agents/agent-runtime-policy.ts`, provider `*-runtime-policy.ts` helpers,
`agents.types.ts`, `agent-runtime-tools-policy.ts`, provider adapters, and Session
type/repository/service propagation.

## TDD evidence

`agent-runtime-policy.contract.spec.ts` and Pi/Codex/Claude provider specs cover read/write
authority, network-off mapping, path/symlink/Git-metadata escape, resume persistence, trusted tools,
and Solo compatibility. Session repository/service specs cover storage and rejection.

## Success criteria

- [x] Frozen explicit policy is reapplied on every member run/resume.
- [x] Foreman/Reviewer have no workspace mutation path.
- [x] Builder cannot escape the canonical worktree.
- [x] No unsupported adapter can resolve Crew ready.
- [x] Hermetic provider conformance and policy contracts passed; credentialed provider integration
  remains optional and is not a release gate.

## Risk and security

Prompt instructions are not enforcement. Global provider settings cannot weaken an explicit
policy. New tools are excluded until independently registered with exact security metadata.

## Next step

Phase 3 composes policy-bound Sessions with the Crew worktree, lease, and context spine.
