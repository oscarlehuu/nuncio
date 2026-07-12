# Phase 3 — One worktree and member execution

## Context links

- [Overview](plan.md)
- [Workspace authority](../../docs/crew-workspace-harness.md#workspace-and-write-authority)
- [Context/session semantics](../../docs/crew-workspace-harness.md#context-and-member-session-semantics)

## Overview

**Priority:** High
**Status:** implemented and locally verified

Composed one run-owned worktree, one Builder lease, ordinary correlated Tasks/Sessions, and bounded
role context.

## Implemented flow

1. Create one `nuncio/crew-<run>-<slug>` worktree from the selected base.
2. Persist canonical path, branch, base/current full head.
3. Create fixed member keys `foreman:primary`, `builder:primary`, `reviewer:primary`.
4. Schedule each attempt through `TasksService` and `SessionsService` with Crew correlation.
5. Give only Builder the exclusive writer lease.
6. Accept schema-bound run/member/phase/context/head submissions through trusted Crew tools.
7. Continue a healthy member Session with a context delta; otherwise create explicit linked
   member lineage.

## Architecture and files

`crew-git-workspace.adapter.ts`, `crew-writer-lease.service.ts`,
`crew-member.service.ts`, `crew-context.service.ts`, context budget/projection/types,
`crew-runtime-tools.service.ts`, tool schemas/validation/authority, execution ports, and task
execution/attempt correlation adapters.

## TDD evidence

Workspace/lease specs cover canonical path, branch, clean/reachable full head, symlinks, duplicate
writers, token release, and Builder-only authority. Member/task specs cover same-session
continuation, linked replacement, restart correlation, and duplicate settlement. Context/tool
specs cover role budgets, authority fields, stale context/head, structured results, and disallowed
tools.

## Success criteria

- [x] Exactly one worktree and writer lease per active run.
- [x] Only `builder:primary` can write.
- [x] Feedback can continue the exact Builder Session/provider thread.
- [x] Hidden reasoning and full member transcripts are not merged.
- [x] Standalone Tasks and Solo Sessions retain their public behavior.
- [x] Workspace, lease, continuation, and context proofs were included in final review.

## Risk and security

Nuncio recomputes Git boundaries; it never trusts a model-supplied path/head. Workspace divergence
blocks instead of resetting or checking out files.

## Next step

Phase 4 drives the fixed workflow and deterministic gates.
