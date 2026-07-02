# Phase 1 — Restart Reconciliation

**Status:** Shipped · **Depends on:** nothing (pure server work)

## Scope

- **Boot sweep** (on module init, before accepting requests):
  - Sessions with status `RUNNING` or a non-null `provider_active_turn_id` → append a `runtime.restarted` event, clear the active turn id, transition to `IDLE`. The transcript shows an honest "daemon restarted mid-turn" marker instead of a ghost spinner.
  - Ask the session's provider whether the thread is resumable (Pi: yes via session file; Cursor CLI: yes via `--resume`; Codex/Cursor SDK in-process runs: no). Store the answer in the event payload so the UI can say "steer to continue" vs "turn was lost".
- **Pending approval expiry:** on boot, `provider_requests` rows with status pending → mark expired (`resolved_at`, reason `daemon-restart`), append a session event so the amber "needs input" state clears and the user sees why.
- **Persist pending requests on creation:** write-through the in-memory map ([sessions.service.ts:52](../../apps/server/src/sessions/sessions.service.ts)) to the `provider_requests` table so the sweep has truth to reconcile against.
- **Pi steer-after-restart:** verify (and fix if broken) that a steer on a reconciled session lazily reopens the Pi session file ([pi-agent.provider.ts:225](../../apps/server/src/agents/providers/pi-agent.provider.ts)) and continues the same conversation.

## Out of scope

- Auto-resuming the interrupted *turn* (re-running the prompt). Reconciliation makes state honest; the human decides whether to re-steer. Auto-retry belongs to the task queue plan.
- Any transport change (Phase B of 260701 owns that).

## Verify

- Integration spec: start run with stub provider → tear down service mid-turn → boot fresh service on same DB → session is IDLE with `runtime.restarted` event, pending request rows expired.
- Integration spec (Pi, gated on Pi availability): create session, complete a turn, re-instantiate provider, steer → reply references earlier context; event `seq` strictly increasing across the restart.
- Manual kill-and-restart per plan.md Verify section.
