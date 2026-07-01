# Phase B — Daemon & Relay Hardening

**Goal:** One typed relay contract, WS transport with gap-free resume + backpressure, token-gated. This is the "smooth streaming" foundation everything else depends on.

## B1 — Extract `packages/core`

Move from `apps/web/src/lib` (pure, portable) into `packages/core`:

- Ports as-is: `api.ts`, `model-*`, `handoff-*`, `transcript-build-blocks`, `tool-summary`, `parse-changelog`, `cursor-context`, all types.
- Adapt: replace relative `fetch('/api/...')` with an injected **host base URL** (no origin assumption). Relay client becomes transport-agnostic (SSE today, WS after B2).
- Stays in `apps/web`: every component (DOM/radix/shadcn/Tailwind) — not portable.

`apps/web` imports `packages/core`. No behavior change; tests move with the code.

## B2 — WebSocket relay

- Server: WS endpoint alongside REST. RPC envelope (matches Synara's `wsRpc` shape): `{ id, method, params }` / `{ id, result|error }` + server-push `{ channel, event }`.
- **Keep event-log semantics on top of WS:** every stream is `subscribe(sessionId, since)` → server replays from `seq > since` then live-pushes. Dropped socket → reconnect resubscribes from last `seq`. This is the gap-free property raw WS lacks.
- Steer becomes a WS RPC call (was POST) — one channel for read + write.
- Client: replace `use-session-stream` EventSource with a WS client in `packages/core`; keep the dedupe/sort/reconnect logic (it already handles `seq`).
- Keep `use-throttled-stream-text` for render; retune to adaptive arrival pace.

## B3 — Backpressure

- Bound per-connection outbound buffer. On overflow: stop pushing, mark connection "behind," let client catch up via `since=` resubscribe rather than buffering unboundedly.
- Prevents fast-agent + slow-phone stalls (Synara's `wsStreamBackpressure` lesson).

## B4 — Token auth

- Bearer token on WS connect + REST. Localhost bypass; required for non-loopback.
- Desktop app generates/stores the token, surfaces it (QR/string) for phone pairing.
- Mirrors Synara `--auth-token` / tailnet model.

## B5 — Multiplex overview stream (optional within B)

- Top-level subscription: all sessions' status/activity on one channel, so desktop shows a live cross-session overview without opening each session.

## Acceptance

- Kill the socket mid-stream → reconnect → transcript identical, no gaps, no dupes.
- Fast mock agent + throttled client → no unbounded memory, client catches up cleanly.
- Non-localhost connect without token → rejected. With token → works over tailnet.
- `apps/web` behaves identically to Phase A from the user's view.

## Contract freeze

At end of Phase B, the WS RPC methods + event channels + auth are **frozen and documented** (`docs/`). Phase C builds against this; changes after freeze are versioned.
