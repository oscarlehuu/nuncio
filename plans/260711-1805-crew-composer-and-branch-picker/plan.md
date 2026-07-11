# Crew Composer and Branch Picker Fixes

**Status:** Complete · **Base:** `origin/dev` · **Target:** `dev`

## Outcome

Show every usable local/remote branch through one shared branch contract, and reduce Crew creation
to a quiet toolbar toggle plus compact profile control without weakening the fixed-worktree contract.

## Verified root causes

1. [`GitService.listBranches()`](../../apps/server/src/git/git.service.ts) runs `git branch`, which
   enumerates local heads only. A repo with local `main` plus remote-only feature branches therefore
   returns only `main` to Home, Workbench, and mobile Crew.
2. [`BranchPicker`](../../apps/web/src/components/branch-picker.tsx) has no `apiBase`; remote-machine
   Workbench projects can query the local daemon instead of the selected hub machine.

## Locked UI behavior

- Solo remains the fresh-composer default, represented by Crew switch **off**.
- One compact `Crew` on/off switch lives in the composer toolbar; no Solo/Crew segmented control.
- Crew on: replace the Solo ModelPicker with one compact inline profile dropdown. With zero profiles,
  show a small setup action, not a disabled oversized “No profiles” control or large empty-state card.
- Keep Project and Base branch visible/truthful in the context row. Hide the Crew worktree label and
  its orphan separator; Crew still always creates its server-owned isolated worktree from that branch.
- Preserve shared components, provider-neutral contracts, and mobile API compatibility.

## Phases

| Phase | Scope | Detail |
|---|---|---|
| 1 | Shared local + remote branch discovery/routing | [phase-01-shared-branch-discovery.md](./phase-01-shared-branch-discovery.md) |
| 2 | Compact Crew toggle/profile composer | [phase-02-compact-crew-composer.md](./phase-02-compact-crew-composer.md) |
| 3 | TDD, visual proof, review, and delivery | [phase-03-verification-and-delivery.md](./phase-03-verification-and-delivery.md) |

## Guardrails

- TDD: assertion-failing regression first, then minimum implementation.
- No implicit `git fetch`: list durable local + remote-tracking refs already present on disk.
- Do not normalize a remote-only ref into an unresolved local name; Crew base resolution must receive
  an exact valid revision such as `origin/feature/x`.
- Patch changeset, xhigh review, `gate:full`, ready PR to `dev`, merge only on green CI.

## Open questions

None. Current source and Git behavior support the requested fix without changing Crew authority.
