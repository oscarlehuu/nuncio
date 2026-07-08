# Phase 2 — Reachability: candidate URLs, funnel automation, stable port

Zero-setup is the constraint: the user clicks "Pair device" and nuncio does everything.

## 1. `src/pairing/candidate-urls.service.ts`

`build(): Promise<{ urls: string[]; hints: string[] }>` — assembled in priority order:

1. **LAN** — `os.networkInterfaces()`: IPv4, `internal === false`, skip link-local 169.254/16 and
   tailscale CGNAT 100.64/10 (reuse `isTailscaleAddress` from `tailscale.service.ts:23-31`) →
   `http://<ip>:<port>` where port = `process.env.PORT ?? 3000`.
2. **MagicDNS (serve)** — if `TailscaleService.status()` is running: `https://<self.dnsName>`
   (strip trailing dot). Only include after `enableServe()` succeeds.
3. **Funnel** — same URL when `enableFunnel()` succeeds (funnel rides the serve config; URL is
   identical — include the hint instead of a duplicate URL when funnel fails).

Hints (surfaced verbatim by web UI + encoded nowhere in the QR):
- tailscale not installed/running → `"Tailscale offline — pairing works on this Wi-Fi only"`
- funnel refused (ACL) → `"Tailscale Funnel unavailable — remote access needs Tailscale on the phone"`

## 2. `TailscaleService` additions (`src/tailscale/tailscale.service.ts`)

Follow the existing `defaultExec` Bun.spawn pattern (3 s timeout) but with a **10 s timeout**
variant for these (first `serve` may provision an HTTPS cert):

- `enableServe(port)` → `tailscale serve --bg <port>`; ok ⇒ true.
- `enableFunnel(port)` → `tailscale funnel --bg <port>`; parse stderr for the ACL-denied message ⇒
  `{ ok: false, reason: 'acl' | 'error' }`.
- Both idempotent (tailscale CLI upserts config) — safe to call on every `pairing/start`.
- Capture stderr (current exec ignores it) — needed to distinguish ACL denial from other failures.

Guardrail: only invoked from `pairing/start` (explicit user action). Never at boot.

## 3. Stable daemon port (`apps/desktop/src/daemon.js`)

Today `findFreePort()` gives a random port per launch (daemon.js:144) → LAN QR URLs die on
restart. Fix in `DaemonSupervisor.start()`:

1. Read `<dataDir>/daemon-port` (dataDir = the `NUNCIO_DATA_DIR` the supervisor already passes in
   `options.env`; fall back to `~/.nuncio/data`).
2. If the persisted port is free (attempt a bind, like `findFreePort` does) → use it.
3. Else `findFreePort()` and persist the new value.

ts.net URLs are port-independent (serve maps 443 → localhost:port), so only the LAN candidate
needs this — but it's also what makes a saved mobile config survive desktop restarts on Wi-Fi.

`bun run dev` (non-desktop) keeps its fixed `PORT` from env — unaffected.

## 4. Files

| File | Change |
|------|--------|
| `apps/server/src/pairing/candidate-urls.service.ts` | new |
| `apps/server/src/tailscale/tailscale.service.ts` | + `enableServe/enableFunnel`, stderr capture |
| `apps/server/src/pairing/pairing.controller.ts` | replace Phase-1 stub with real builder |
| `apps/desktop/src/daemon.js` | persisted-port read/verify/write |

## 5. Tests

- `candidate-urls.spec.ts`: injected fake `networkInterfaces` + fake tailscale service — ordering,
  CGNAT/link-local exclusion, hint generation for each degraded mode.
- `tailscale.service` spec: `enableFunnel` ACL-stderr parsing via injected exec.
- `apps/desktop/test/daemon.test.js`: persisted port reused when free; regenerated + re-persisted
  when occupied (existing listen-based test helpers cover this).

## Verify

Server tests + `bun run --filter @nuncio/desktop test`. Manual: run `pairing/start` twice on a
tailscale machine → same URLs; `tailscale serve status` shows the mapping; QR URL from before a
desktop restart still answers `/api/health`.

## Edge cases / risks

- Multiple LAN IPv4s (Wi-Fi + Ethernet + VM bridges): include all non-excluded ones; mobile probe
  sorts it out. Cap at 4 to keep the QR small.
- `tailscale funnel` needs HTTPS on 443/8443/10000 — `--bg <port>` handles the mapping; if the
  CLI is older than the `funnel` subcommand, treat as `reason: 'error'` hint.
- QR density: 2–4 URLs + code ≈ 200 bytes → QR version ~10, scans fine; don't exceed ~350 bytes.
