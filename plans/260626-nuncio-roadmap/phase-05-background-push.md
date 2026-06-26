# Phase 05 — Web Push + Webhooks

**Status:** Planned · **Depends on:** Phase 2 (installed PWA)

## Scope
- VAPID + `POST /api/push/subscribe`
- Push on `IDLE`, `PAUSED`, `ERROR`
- SW push + notificationclick deep link
- Optional Slack/Telegram webhook

## Agent ownership
- **A:** `apps/server/src/push/**`
- **B:** client subscribe + SW handlers
- **C:** onboarding "Enable notifications"
