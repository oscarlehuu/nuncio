# Phase 1 — Server: devices, pairing, device-auth branch

Everything in `apps/server`. Mirrors existing patterns: `push.repository.ts` (repository),
`public.decorator.ts` + `auth.guard.ts` (auth), `settings.registry.ts` (settings keys).

## 1. Schema (`src/db/database.service.ts`)

Append to the inline `SCHEMA` const (CREATE TABLE IF NOT EXISTS style, like `push_tokens`):

```sql
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  secret_hash TEXT NOT NULL,
  prev_secret_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
```

No `migrate()` work needed (new table, not an ALTER).

## 2. New module `src/devices/`

**`devices.repository.ts`** — `@Injectable`, inject `DatabaseService`, prepared statements only:
`insert(row)`, `findById(id)`, `list()` (ordered by `last_seen_at` desc), `revoke(id)` (sets
`revoked_at`), `touchLastSeen(id, ts)`, `setSecret(id, secretHash, prevSecretHash)`,
`clearPrevSecret(id)`.

**`devices.service.ts`** — owns credential logic:
- `create(name, platform)` → `{ id: randomBytes(8).base64url, secret: randomBytes(32).base64url }`;
  stores `sha256(secret)` hex. Returns the raw secret exactly once.
- `verify(deviceId, candidateSecret)` → constant-time compare (same `timingSafeEqual`-on-sha256
  trick as `auth-token.service.ts:32-41`) against `secret_hash`, then `prev_secret_hash`.
  Rules: revoked ⇒ false. Match on `secret_hash` while `prev_secret_hash` is set ⇒ clear prev
  (first use of the new secret confirms rotation). Match on `prev_secret_hash` ⇒ valid (grace).
  On success: `touchLastSeen` throttled to ≥60 s between writes (avoid a write per request).
- `rotate(deviceId, authedSecret)` → new 32-byte secret; `prev_secret_hash := hash(authedSecret)`,
  `secret_hash := hash(new)`. Always exactly one valid old generation — rotating twice from the
  old secret keeps only the latest pair.

**`devices.controller.ts`**
- `GET /api/devices` (guarded) → `[{ id, name, platform, createdAt, lastSeenAt, revoked }]` — never hashes.
- `DELETE /api/devices/:id` (guarded) → revoke (soft: keep the row for the list, `revoked` badge).
- `POST /api/devices/rotate` (device bearer ONLY — reject global-token/loopback/tailscale callers:
  rotation must prove possession of the current secret) → `{ deviceId, deviceSecret }`.

**`devices.module.ts`** — exports `DevicesService`; imported by `AuthModule` (guard needs it) and
`AppModule`.

## 3. New module `src/pairing/`

**`pairing.service.ts`** — in-memory single active code:
`{ code: randomBytes(16).base64url, expiresAt: now+5min }`. `start()` replaces any prior code.
`consume(candidate)` → constant-time compare, checks TTL, clears on success (single-use).
No DB — a restart invalidating a pending code is fine (user just re-opens the QR).

**`rate-limit.ts`** — tiny fixed-window limiter (no dep; repo has no throttler):
`allow(key, { max: 10, windowMs: 60_000 })` over a `Map<string, {count, windowStart}>` with
periodic sweep. Unit-testable with injected clock.

**`pairing.controller.ts`**
- `POST /api/pairing/start` (guarded): calls Phase-2 `CandidateUrlsService.build()` (Phase 1 stub:
  LAN URLs only) → `{ code, expiresAt, urls, hints }`.
- `POST /api/pairing/claim` (`@Public()` + rate limit by `req.socket.remoteAddress`):
  body `{ code, deviceName, platform }` → 429 over limit, 401 bad/expired code, else
  `devices.create()` → `{ deviceId, deviceSecret, serverName: os.hostname() }`.

## 4. Auth branch (`src/auth/`)

**`device-token.ts`** (new): `parseDeviceBearer(header)` → `{ deviceId, secret } | null` for
`Bearer nd1.<id>.<secret>` (split on dots, exactly 3 parts, charset-check base64url).

**Wire-up** — keep `isAuthorizedRequest` signature stable; add an optional device validator:
- `auth.guard.ts`: after global-token check, before tailscale: parse `nd1.` bearer → `devices.verify()`.
- `upgrade-auth.ts`: same branch in `isAuthorizedUpgrade` (new optional param, default undefined —
  existing call sites unaffected until `main.ts` passes `DevicesService`).
- `main.ts`: pass the device validator into `attachSessionsWebSocketServer` / `attachTerminalWebSocketServer`.
- `hub.proxy.ts` edge auth: NOT extended (out of scope, see plan.md).

## 5. Tests (`test/unit/`) — bun test, AppModule fixture pattern from `app.spec.ts`

- `pairing.spec.ts`: claim happy path (code → deviceId/secret → authed GET /api/sessions with
  `nd1.` bearer succeeds); expired code 401; second claim of same code 401; wrong code 401;
  11th claim in a minute 429; new `start` invalidates the previous code.
- `devices.spec.ts` (service-level, no HTTP): rotation state machine — verify(new) clears prev;
  verify(old) still true before first new-use, false after; double-rotate from old keeps one
  generation; revoke ⇒ verify false; lastSeen throttling.
- `upgrade-auth.spec.ts` (extend if exists): WS upgrade with `nd1.` bearer accepted; revoked rejected.
- Simulate remote callers: guard treats loopback as trusted, so specs must set a non-loopback
  `remoteAddress` on the request mock (existing pattern in auth specs) to exercise the branch.

## Verify

```
bun run --filter @nuncio/server lint && bun run --filter @nuncio/server test
```

Manual: `curl -X POST :3300/api/pairing/start` (loopback) → take code →
`curl -X POST :3300/api/pairing/claim -d '{"code":...,"deviceName":"test"}'` →
`curl -H "Authorization: Bearer nd1.<id>.<secret>" :3300/api/sessions` from a non-loopback iface.

## Edge cases / risks

- Claim response is the ONLY time the secret exists in plaintext over the wire — over Funnel this
  is TLS; over LAN it's HTTP (accepted for home Wi-Fi; noted in plan.md open items).
- `rotate` authed via the *prev* secret must set `prev := prev` (the secret that authed), not the
  unclaimed newer one — otherwise a lost-write client rotates itself into lockout. Covered in spec.
- Rate limiter key is remoteAddress: behind Funnel all claims appear from the tailscale proxy —
  acceptable (10/min global via funnel still fine for a single-user server).
