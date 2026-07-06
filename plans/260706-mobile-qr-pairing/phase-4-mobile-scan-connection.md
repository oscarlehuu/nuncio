# Phase 4 — Mobile: QR scan, claim, connection manager

`apps/mobile` + shared logic in `packages/core` (so web/tests reuse it). Consumes the frozen
Phase-1/2 contract. Existing building blocks: `connection-store.ts` (secure persistence),
`session-relay-client.ts` (WS + seq cursor + `resync()`), AppState foreground hook already wired
in `use-session-transcript.ts:115-117`.

## 1. Dependencies (`apps/mobile/package.json` + `app.json`)

- `expo-camera` — `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`.
  (NOT `expo-barcode-scanner` — deprecated since SDK 50.) Plugin entry in `app.json` with
  `cameraPermission` copy.
- `@react-native-community/netinfo` — network-change events for re-probe.
- ATS/cleartext for LAN HTTP: `ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking =
  true`; `android.usesCleartextTraffic = true`.
- Re-run the `expo export --no-bytecode` smoke after adding plugins (babel/monorepo pins are
  fragile — see expo-mobile-monorepo-setup memory).

## 2. Shared logic in `packages/core` (new `src/pairing-client.ts`)

- `parsePairingQr(text)` → `{ code, urls } | null` (validates `v === 1`, non-empty base64url code,
  http(s) URL array ≤ 8 entries).
- `probeCandidates(urls, { fetchImpl, timeoutMs = 3000 })` → first healthy URL by priority: fire
  all `GET /api/health` in parallel (AbortController timeout each), resolve to the **first in
  array order** that succeeded (not first-to-respond — order encodes LAN-first preference; wait
  max `timeoutMs` overall).
- `claimPairing(baseUrl, { code, deviceName, platform }, fetchImpl)` → `{ deviceId, deviceSecret,
  serverName }`; maps 401 → "code expired", 429 → "too many attempts".
- Unit-tested with fake fetch — this is the contract test for the QR payload.

## 3. Connection store v2 (`apps/mobile/src/lib/connection-store.ts`)

```ts
interface ConnectionConfig {
  serverUrl: string;              // active base URL
  token: string | null;           // legacy manual pairing (kept working)
  deviceId?: string;
  deviceSecret?: string;
  candidateUrls?: string[];       // from the QR, for re-probing
}
```
- Load path accepts the old `{serverUrl, token}` JSON unchanged (backward compat — existing
  paired phones keep working).
- `authHeader(config)` helper: device creds ⇒ `Bearer nd1.<id>.<secret>`, else legacy token.
  `api-setup.ts` and the WS factory in `use-session-transcript.ts:97-112` both switch to it.

## 4. Pairing screen (`src/app/pairing.tsx`)

- Add "Scan QR" as the primary action above the existing manual form (keep the form — hub users
  and no-camera cases still need it).
- Scan flow: `CameraView` full-screen modal → `parsePairingQr` → `probeCandidates` →
  `claimPairing` → `saveConnection(v2)` → `applyConnection` → `router.replace('/')` →
  `registerForPush()` (existing).
- Error states: unreachable (all probes failed → "Can't reach the desktop — same Wi-Fi?"),
  expired code, camera permission denied (link to system settings).

## 5. Connection manager (`src/lib/connection-manager.ts`, new)

Owns which base URL is live; the relay client stays dumb.

- On NetInfo change or WS close: re-probe `candidateUrls`, switch `serverUrl` + reconfigure api
  client if the winner changed, then `resync()`.
- Backoff for repeated failures: 0.5 s → 8 s exponential + full jitter; reset on success;
  immediate attempt on AppState → `active` (bypasses the backoff timer).
- Exposes `state: 'connected' | 'connecting' | 'offline' | 'server-shutdown'` for the UI —
  a thin status pill on the session list header.

`session-relay-client.ts` changes (additive, keep default behavior for web):
- `reconnectMs` → optional `reconnectDelays?: (attempt) => number` hook (manager supplies backoff).
- Surface unknown top-level frames: `onNotice?: (notice: string) => void` — manager maps
  `server_shutdown` → state `server-shutdown` and stops reconnecting until AppState/NetInfo kicks.

## 6. Secret rotation (client side)

After the first successful authed call per app-launch: `POST /api/devices/rotate` →
**persist the new secret to secure store first**, then swap the in-memory header. If persist
throws, keep using the old secret (server grace keeps it valid). If rotate 401s (revoked), clear
connection → route to pairing screen with "This device was revoked".

## 7. Files

| File | Change |
|------|--------|
| `packages/core/src/pairing-client.ts` (+spec) | new — parse/probe/claim |
| `packages/core/src/session-relay-client.ts` (+spec) | backoff hook + `onNotice` |
| `apps/mobile/src/lib/connection-store.ts` (+spec) | v2 config + `authHeader` |
| `apps/mobile/src/lib/connection-manager.ts` (+spec) | new |
| `apps/mobile/src/lib/api-setup.ts` | use `authHeader` |
| `apps/mobile/src/lib/use-session-transcript.ts` | WS factory header + manager wiring |
| `apps/mobile/src/app/pairing.tsx` | scan flow |
| `apps/mobile/app.json`, `package.json` | deps/plugins/ATS |

## 8. Tests + verify

- Core: QR parser (bad version/URL/code), prober (order-priority beats first-response, timeout,
  all-fail), claim error mapping, backoff schedule + jitter bounds, `onNotice` dispatch.
- Mobile (vitest): store v2 round-trip + legacy migration; manager state transitions with fake
  NetInfo/AppState/relay.
- `bun run --filter @nuncio/mobile check` (typecheck + lint + test) + `expo export` smoke.
- Manual device pass (required): pair via QR on real iPhone; kill Wi-Fi → cellular → watch it
  fail over to Funnel; background 10 min → foreground → transcript resumes gap-free; revoke from
  web → phone lands on pairing screen.

## Edge cases

- Two QR scans in quick succession (double claim): second claim 401s (single-use) — treat as
  expired-code UX.
- Probe winner ≠ claim target: claim on the probe winner; store ALL urls regardless.
- Clock skew: countdown/expiry decided server-side only (client never validates `expiresAt`).
