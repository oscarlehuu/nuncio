# Phase 03 — Shell eval acceptance (Track A)

## Context links

- `eval:extract` harness (shipped, PR #122) — recorded real sessions → replayable eval tasks.
- Locked decision 7: eval replay is the acceptance gate of Track A.
- `apps/server/test/e2e/crew.e2e-spec.ts` — full fixed workflow in a real worktree (forced Mock).

## Overview

Priority: medium (runs after phases 01–02 merge). Prove the investment with data instead of
believing it: A/B the Builder role between `codex` (today's only shelled Builder) and
`pi` + sandboxed shell on replayed real tasks.

## Requirements

- Task set: seeded from recorded real sessions with the user (curation is a user-in-the-loop step;
  the harness study already locked "eval task set = recorded real sessions").
- Metrics per binding: first-verify green rate, verify retries consumed, wall-clock, tokens.
- Output: a short report in `plans/reports/` (`eval-260719-pi-shell-vs-codex-builder.md`);
  no product code changes required by this phase.

## Implementation steps

1. Extract 3–5 representative Builder-shaped tasks from the recorded event log (`eval:extract`).
2. Run each task through a Crew run twice (Builder=codex / Builder=pi-with-shell), same Foreman
   and Reviewer bindings, same frozen verify command.
3. Record metrics; write the report; recommend the default Builder guidance in docs if pi wins or
   ties (cost counts as a tiebreaker).

## Todo

- [ ] Curate task set with user
- [ ] Run A/B, collect metrics
- [ ] Report + docs guidance update

## Success criteria

A written, reproducible comparison exists; the "Builder on Nuncio Engine is now competitive" claim
is either verified with numbers or explicitly refuted (also a valid outcome).
