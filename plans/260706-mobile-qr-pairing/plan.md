# Mobile QR Pairing + Persistent Connection

**Status:** Planned (detailed) · extends `260701-desktop-daemon-mobile` (A/B/C shipped)
**Worktree:** `upbeat-shtern-29f830` (backend 3300 / web 5473, shared data dir)
**Thesis:** Desktop shows a QR once; the phone scans once and stays connected everywhere —
LAN at home, Tailscale Funnel on the go — with per-device rotating secrets and a daemon that
survives window close (menu-bar mode).

## Decisions (locked with Oscar, 2026-07-06)

| Decision | Choice | Why |
|----------|--------|-----|
| Credential model | **Per-device id + secret, auto-rotating** | Scan exactly once; secret rotates on connect (refresh-token style) with one-generation grace so a mid-rotation crash never forces a re-scan. Global server token untouched for web/desktop. |
| Connectivity | **Candidate URLs: LAN + MagicDNS + Funnel, zero-setup** | Phone installs nothing. Nuncio auto-runs `tailscale serve`/`funnel` on pairing start; degrades to LAN-only with a visible hint. Oscar: "không cần setup gì quá nhiều". |
| Window close | **Hide to menu bar (default on, toggleable)** | Daemon keeps running; explicit quit broadcasts a farewell so mobile flips to "Desktop offline" instantly. |
| Transport | **Unchanged** — WS relay + seq-cursor replay (ADR-007) | Already gap-free (15 s heartbeat, 1 MB backpressure + `behind` marker). Smoothness work is client-side. |

Physics note: Codex-style "works from anywhere, zero phone setup" needs a reachable endpoint;
nuncio has no SaaS relay (vision pillar 1). Tailscale Funnel (public HTTPS `*.ts.net`, Tailscale
only on the desktop) is the closest self-hosted equivalent.

## Contracts (frozen across phases — additive-only after Phase 1 lands)

**QR payload (v1):**
```json
{ "v": 1, "code": "<pairing code>", "urls": ["http://192.168.1.20:3000", "https://mac.tailnet.ts.net"] }
```
URL priority on mobile: LAN → MagicDNS → Funnel (probe `/api/health`, pick first healthy, re-probe on network change).

**Device bearer token:** `Authorization: Bearer nd1.<deviceId>.<deviceSecret>` — the `nd1.` prefix
routes the auth guard to the device branch; the existing global token has no dots, so the two
never collide. Works identically on REST and WS upgrade (RN WebSocket sends headers).

**New endpoints:**

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/pairing/start` | guarded | Mint single-use code (5 min TTL) + candidate URLs + hints |
| `POST /api/pairing/claim` | **public**, rate-limited | Exchange code → `{deviceId, deviceSecret}` (returned once) |
| `POST /api/devices/rotate` | device bearer only | Rotate the calling device's secret (one-generation grace) |
| `GET /api/devices` | guarded | List paired devices for settings UI |
| `DELETE /api/devices/:id` | guarded | Revoke a device |

**New WS frame (server → client, additive to ws-relay-contract v1):**
`{ "notice": "server_shutdown" }` — broadcast to all sockets before SIGTERM completes.

## Phases

| Phase | Focus | Plan |
|-------|-------|------|
| 1 | Server: `devices` table, pairing endpoints, device-auth branch, rotation, rate limit | [phase-1-server-devices-pairing.md](./phase-1-server-devices-pairing.md) |
| 2 | Reachability: candidate-URL builder, `tailscale serve/funnel` automation, stable daemon port | [phase-2-reachability-urls.md](./phase-2-reachability-urls.md) |
| 3 | Web UI: QR card + paired-devices management in Remote access settings | [phase-3-web-qr-ui.md](./phase-3-web-qr-ui.md) |
| 4 | Mobile: QR scan, claim, connection manager (multi-URL, backoff, rotation, farewell) | [phase-4-mobile-scan-connection.md](./phase-4-mobile-scan-connection.md) |
| 5 | Desktop: tray/menu-bar mode, farewell broadcast, single-instance lock | [phase-5-desktop-tray-farewell.md](./phase-5-desktop-tray-farewell.md) |

Ordering: 1 → 2 → 3 ship together as the server+desktop side (a QR you can already claim with
`curl`). 4 consumes the frozen contract. 5 is independent of 4 after the farewell frame shape is
fixed (it is, above). Do not start 4 until 1's endpoints are merged — the mobile app pins the
contract.

## Security invariants

- Pairing code: single-use, 5 min TTL, one active code at a time (new mint invalidates the old).
- `claim` is public because Funnel exposes it → fixed-window rate limit per IP (10/min) + constant-time code compare.
- Device secrets: 32 random bytes, stored as SHA-256 hashes only, constant-time compare, never logged, never in URLs.
- Rotation grace: exactly one previous generation stays valid; cleared on first use of the new secret.
- Funnel/serve are enabled on explicit pairing action, never silently at boot.
- Revoked device ⇒ 401 on both REST and WS upgrade immediately (no cache).

## Open items (non-blocking)

- Funnel ACL not enabled on the tailnet → degraded-mode copy in the UI (hint string from Phase 2).
- Leave `tailscale serve/funnel` config persistent on quit (tailscaled persists it; re-pairing is idempotent). Revisit if Oscar wants a "disable remote access" toggle to tear it down.
- Hub (`/m/<machine>/`) device-auth at the hub edge — out of scope; global-token/whois path still covers hub today.
