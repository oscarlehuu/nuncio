# Phase 3 — Web UI: QR card + device management

All in `apps/web`, inside the existing Remote access settings section. Follow its exact
conventions: vanilla fetch helpers in `lib/`, `useState`+`useEffect` (no react-query), sonner
toasts, shadcn `Dialog` for destructive confirm, `divide-y divide-border/60` card layout.

## 1. `src/lib/devices-api.ts` (new, mirrors `lib/tailscale-api.ts` style)

```ts
startPairing(): Promise<{ code: string; expiresAt: number; urls: string[]; hints: string[] }>
listDevices(): Promise<DeviceDto[]>
revokeDevice(id: string): Promise<void>
```
Plain `fetch('/api/...')` — the global `installApiBaseFetch()` wrapper handles hub prefixes.

## 2. `remote-access-settings-section.tsx` — two additions

**"Pair mobile device" block** (new row in the existing card):
- Idle: title + description + `Button size="sm"` "Show QR".
- Active: QR rendered from `JSON.stringify({ v: 1, code, urls })`, countdown from `expiresAt`
  (mm:ss), "New code" button (calls `startPairing` again — server invalidates the old code), and
  the `hints[]` strings as muted text under the QR.
- Expired: QR dims + "Code expired" + regenerate button.
- On open, also render the payload as copyable text (manual entry fallback stays useful).

**"Paired devices" block**:
- `listDevices()` on mount + after revoke; rows in the PeerRow layout (name + platform left,
  `lastSeenAt` relative time + Revoke button right; `Badge variant="outline"` "Revoked" for soft-revoked rows).
- Revoke: shadcn `Dialog` confirm (pattern from `session-detail.tsx:884-908`, NOT `window.confirm`
  — a revoked phone is a real lockout) → `toast.success('Device revoked')`.
- Auto-refresh the list while the QR is visible (poll every 3 s) so a successful claim appears
  live — this doubles as the "pairing succeeded" feedback.

## 3. QR rendering

- Dep: `qrcode.react` (`QRCodeSVG`, ~10 kB gz, zero deps). SVG — crisp on retina, themable via
  `fg`/`bg` from CSS vars.
- The settings view imports sections statically today, but keep the QR dep out of the entry
  bundle anyway: `React.lazy` just the QR block (`const PairQr = lazy(() => import('./pair-qr'))`)
  with a `Suspense` skeleton — cheap and respects the bundle-budget direction even though the
  budget spec file isn't on this branch.

## 4. Settings search registry (`settings-view.tsx`)

Add keywords to the remote-access section match list (~line 302-309): `'pair'`, `'device'`,
`'qr'`, `'mobile'`, `'phone'`.

## 5. Files

| File | Change |
|------|--------|
| `apps/web/src/lib/devices-api.ts` | new |
| `apps/web/src/components/pair-qr.tsx` | new (lazy QR block) |
| `apps/web/src/components/remote-access-settings-section.tsx` | + two blocks |
| `apps/web/src/components/settings-view.tsx` | + search keywords |
| `apps/web/package.json` | + `qrcode.react` |

## 6. Tests + verify

- `remote-access-settings-section.spec.tsx` (existing spec file — extend): mock `devices-api`;
  QR appears after clicking "Show QR" (assert payload text, not SVG internals); countdown expiry
  flips to regenerate state; revoke opens Dialog and calls API on confirm; hints rendered.
- `bun run --filter @nuncio/web lint && bun run --filter @nuncio/web test`.
- Real browser (required by repo rule, jsdom misses Radix/layout): playwright-core against
  `localhost:5473` — open Settings → Remote access, click Show QR, screenshot; scan the QR with a
  phone camera to confirm density/contrast is scannable in both themes.

## Edge cases

- `startPairing` fails (server can't reach tailscale etc.): toast the error, still show LAN-only
  QR if `urls` came back non-empty.
- Countdown drift: compute from `expiresAt - Date.now()` per tick, not a local decrement.
- Dark theme: QR must render dark-on-light inside a white-padded tile — scanners need quiet zone
  and contrast regardless of app theme.
