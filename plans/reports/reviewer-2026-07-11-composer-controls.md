# Composer control consolidation review

## Findings

No actionable findings.

The initial boxed-height concern was invalidated by direct evidence: `cn()` delegates to `tailwind-merge` (`apps/web/src/lib/utils.ts:1-25`), which removes the conflicting `h-8` class when the later compact `h-7` is supplied. The rendered-DOM regression test confirms `h-7` is present and `h-8` absent for `variant="boxed" compact`; `apps/web/src/components/model-picker.spec.tsx` passes all 24 tests.

## Verified

- Provider permission picker plumbing is fully removed from Home/Grid/Session while provider-request transcript cards and response callbacks remain.
- Claude unset and invalid permission-mode values resolve to `bypassPermissions`; explicit runtime policies still override to the constrained `default` mode.
- `preventOutsideDismiss` composes the caller handler and is applied to the six intended form surfaces; Escape and explicit close remain available.
- Patch changeset and README/AGENTS updates are present.
- Targeted verification: web 137 tests passed; server 85 tests passed; model-picker recheck 24 tests passed; web/server lint and web production build passed (existing warnings only).

## Unresolved questions

None.

**Status:** DONE  
**Summary:** Review is clean; the implementation preserves the shared provider-neutral contracts and the compact model-picker density works in rendered DOM.  
**Concerns/Blockers:** None.
