# Phase 4 — Hardening, integration test, docs, ship

**Effort:** 1d
**Depends on:** Phases 2 + 3.

## Opt-in integration test (real SDK, real auth)

- `apps/server/test/integration/claude-agent.integration.spec.ts`, gated by `NUNCIO_CLAUDE_INTEGRATION=1` (mirror `test:integration:codex` in `apps/server/package.json:13`).
- Scenarios (cheapest model, tiny prompts, isolated tmp workspace):
  1. run → deltas → final message matches result text.
  2. steer (per declared capability) → second turn coherent.
  3. interrupt mid-turn → INTERRUPTED/IDLE clean, follow-up works.
  4. resume: dispose provider, new provider instance, steer with `providerThreadId` → context retained.
- Add `test:integration:claude` script + hook into the daily-driver aggregate if Oscar wants it in that rotation.

## Hardening sweep

- Error taxonomy: not-logged-in (probe fails mid-session), API-key invalid, `resume` cwd mismatch, budget/max-turn result subtypes — each lands ERROR with a message a user can act on (no swallowed errors).
- Subprocess audit: N sessions → dispose all → zero `claude` processes left (S9 assertions become a unit/integration check where feasible).
- Daemon restart drill with an active Claude session: status recovers, resume works, no duplicate events (durability lanes interaction).
- Payload truncation: verify big tool outputs behave under the 4KB event truncation.

## Docs + release

- `README.md`: add `claude` to the provider list + auth note (logged-in `claude` CLI **or** `ANTHROPIC_API_KEY`; no OAuth flow in nuncio).
- `AGENTS.md`: provider section entry + quirks (cwd-scoped resume, permission-mode setting, settingSources default).
- `docs/architecture-decisions.md`: if any locked decision needs an ADR note (SDK-primary surface choice), add it; ADR-004 itself unchanged.
- Changeset: `bun run add-changeset minor "Add Claude provider (Claude Agent SDK)"`.
- Full gate: `bun run build && bun run lint && bun run test && bun run test:e2e`, codex exec review of the full diff, desktop smoke per orchestration protocol, then PR.

## Ship checklist

- [ ] Conformance suite green for claude (unit, stubbed).
- [ ] Opt-in integration green on this Mac (subscription auth).
- [ ] No `if (provider === 'claude')` outside `agents/providers/**` (grep gate).
- [ ] Founder decisions D1–D3 recorded in plan.md as resolved.
- [ ] Changeset + docs in the same PR.
