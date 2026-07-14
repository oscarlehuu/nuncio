# Frontend coverage gaps — component spec pass

Date: 2026-07-14  
Worktree: `0xo6`  
Gate: `cd apps/web && bun run test -- src/components/mode-toggle.spec.tsx …` → **23 pass / 0 fail** (8 files)

## Specs added (this pass)

| Spec | Component | Coverage focus |
|---|---|---|
| `mode-toggle.spec.tsx` | `mode-toggle.tsx` | Theme trigger, light/dark/system menu, `setTheme` + localStorage |
| `fast-lightning-toggle.spec.tsx` | `fast-lightning-toggle.tsx` | Active aria-label, inactive `aria-hidden`, success styling |
| `provider-request-card.spec.tsx` | `provider-request-card.tsx` | Pending/resolved badges, command detail, approve/deny callbacks |
| `queued-steers-panel.spec.tsx` | `queued-steers-panel.tsx` | Empty null render, queue list + count, multitask button + disabled state |
| `attention-row.spec.tsx` | `attention-row.tsx` | Permission Open/Dismiss, crew Mark seen vs Dismiss |
| `setting-row.spec.tsx` | `setting-row.tsx` | Read-only display, boolean switch, string save, option select |
| `pair-qr.spec.tsx` | `pair-qr.tsx` | QR + payload render (mocked `qrcode.react`), copy feedback, dimmed/disabled |
| `session-scm-conflicts.spec.tsx` | `session-scm-conflicts.tsx` | Empty null render, singular/plural conflict banner + paths |

## Already covered (prior pass — do not duplicate)

- `loop-status-chip.spec.tsx`, `verify-chip.spec.tsx`
- lib: `subagent-hold`, `usage-heatmap-utils`, `timeline-links`, `keyboard`, `usage-percent-preference`, `hub-api`, `use-session-stream`, `remark-code-path-links`, `preferences-api`, `auth-api`

## Notes

- `pair-qr.spec.tsx` mocks `qrcode.react` only; copy interaction asserts UI feedback (Check icon) because jsdom exposes a working `navigator.clipboard`.
- `attention-queue` skipped — row-level coverage sufficient for inbox actions; queue container is thin list wiring.

## Residual gaps (not in this pass)

- `attention-row` dispatcher-proposal expand/collapse + Approve flow
- `setting-row` clear-button paths for db-sourced options
- Deeper integration via `inbox-view` / `settings-view` already partially covered elsewhere

## Round 2

Date: 2026-07-14  
Gate: `cd apps/web && bun run test -- src/lib/devices-api.spec.ts …` → **45 pass / 0 fail** (8 files)

### Lib specs added

| Spec | Module | Coverage focus |
|---|---|---|
| `devices-api.spec.ts` | `devices-api.ts` | `startPairing` / `listDevices` / `revokeDevice` success + HTTP errors |
| `tailscale-api.spec.ts` | `tailscale-api.ts` | `fetchTailscaleStatus`, `pushProvision`, JSON error-body parsing |
| `forge-api.spec.ts` | `forge-api.ts` | `forgeFetch` message fallback, `fetchForgePulls` / `fetchForgeIssues` / `mergeForgePull` |
| `unregister-service-worker.spec.ts` | `unregister-service-worker.ts` | SW unregister, workbox/nuncio cache purge, no-op + swallow errors |

### Forge component specs added

| Spec | Component | Coverage focus |
|---|---|---|
| `forge-ui.spec.tsx` | `forge-ui.tsx` | `forgeTimeAgo`, `checkStatusClass`, `ForgeStateBadge`, `ChecksList`, `ForgeCommentCard` |
| `pr-list.spec.tsx` | `pr-list.tsx` | Loading/empty states, open/merged/closed chips, row click, fetch error toast |
| `issue-list.spec.tsx` | `issue-list.tsx` | Open/closed/mine filters, new-issue dialog wiring, fetch error toast |
| `new-issue-dialog.spec.tsx` | `new-issue-dialog.tsx` | Title gate, create success/error toasts, cancel |

### Notes

- `unregister-service-worker.spec.ts` uses dynamic import + `vi.resetModules()` so `caches` global stub binds before module load (jsdom has no native `caches` global).
- `issue-list.spec.tsx` mocks `NewIssueDialog` to keep list tests focused; dialog behavior covered in `new-issue-dialog.spec.tsx`.
- `pr-review-bar.tsx` deferred — list/UI helpers prioritized this round; bar shares review actions with existing PR detail paths.

### Residual gaps (Round 2)

- `pr-review-bar.tsx` approve/request-changes/merge affordances
- Full `forge-api.ts` endpoint matrix (shared `forgeFetch` helper covers error path for most)
- Deep forge panel integration (PR detail, thread reply) — component-level only here
