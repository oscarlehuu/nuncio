# Session WS relay — frozen contract (v1)

The session relay is the duplex transport used by remote clients (web, Expo
mobile) for live transcripts and steering. It carries the same event-log
semantics as the REST/SSE endpoints: the durable `seq` cursor is the source of
truth and every subscription replays from a client-supplied cursor before
going live, so a dropped socket never loses or duplicates events.

Changes to this contract after v1 must be versioned (new method names or an
envelope `v` field), never breaking.

## Endpoint

- Direct: `GET ws(s)://<host>/api/sessions/ws` (HTTP upgrade)
- Through a hub: `ws(s)://<hub>/m/<machine>/api/sessions/ws` — the hub relays
  frames verbatim to the target machine's endpoint.
- Keepalive: the server sends a WS ping every 15s.

## Authorization (at upgrade)

Same rule as every `/api` route, enforced before the handshake completes:

1. Loopback connections always pass.
2. Otherwise a valid access token as `Authorization: Bearer <token>` header
   (React Native / API clients) or the `nuncio_token` cookie (browsers —
   browser WS handshakes cannot carry custom headers, the cookie rides along
   automatically on same-origin connects).
3. Otherwise a Tailscale whois-trusted peer (same tailnet account).

Unauthorized upgrades are destroyed without a handshake. There is no
query-string token form — tokens must never appear in URLs or logs.

When connecting through a hub, this authorization happens **at the hub edge**;
the target machine trusts the hub's tailnet identity for the second hop.

## Envelope

Client → server requests:

```json
{ "id": 1, "method": "subscribe", "params": { "sessionId": "…", "since": 0 } }
```

Server → client responses (correlated by `id`):

```json
{ "id": 1, "result": { "ok": true } }
{ "id": 1, "error": { "code": 404, "message": "Session not found" } }
```

Server → client pushes (no `id`):

```json
{ "channel": "<sessionId>", "event": { "seq": 7, "type": "assistant_delta", "payload": {}, "createdAt": 0 } }
{ "channel": "<sessionId>", "behind": true }
```

Server → client notices (no `id`, no `channel`):

```json
{ "notice": "server_shutdown" }
```

## Notices

A `notice` frame is an out-of-band signal about the connection or server, not
tied to any session channel. It is additive to v1: clients ignore any frame
whose top-level keys they do not recognize, so an older client simply drops an
unknown notice.

| Notice | Meaning | Client action |
|---|---|---|
| `server_shutdown` | The server is shutting down (explicit quit) and this socket is about to close. | Treat the server as offline immediately instead of waiting out the heartbeat timeout, then reconnect with backoff. |

`server_shutdown` is broadcast to every open socket just before teardown on
`SIGTERM`/`SIGINT`. It is best-effort and fire-and-forget: the server does not
wait for the frame to flush before closing, and a crash (rather than a clean
quit) sends no notice — clients fall back to the heartbeat timeout and reconnect
in that case.

## Methods

| Method | Params | Result | Notes |
|---|---|---|---|
| `subscribe` | `sessionId`, `since?` (default 0) | `{ ok: true }` | Replays events with `seq > since` as channel pushes, then streams live. Subscribing again to the same session replaces the previous subscription (cursor recovery). Unknown session → error 404. |
| `unsubscribe` | `sessionId` | `{ ok: true }` | Stops pushes for that session. |
| `steer` | `sessionId`, `message`, `forceResume?` | the updated session DTO | Same semantics and error codes as `POST /api/sessions/:id/steer` (400 invalid, 409 CLI busy, 503 CLI missing). |

Anything else → error 400.

## Backpressure (`behind`)

Per-connection outbound buffering is bounded (1 MB). When a subscription's
socket cannot drain fast enough, the server **drops the subscription** instead
of buffering unboundedly and sends one `{ channel, behind: true }` marker. The
client recovers by resubscribing with `since = <last seq it has seen>` — the
replay fills the gap. `@nuncio/core`'s `subscribeSessionEvents` does this
automatically.

## Client contract (`@nuncio/core/session-relay-client`)

`subscribeSessionEvents({ url, sessionId, since, onEvent, webSocketFactory? })`
owns the gap-free property: it tracks the highest `seq` seen, resubscribes from
it on reconnect (2s), on `behind`, and on `resync()` (tab visible / app
foregrounded). `call(method, params)` issues RPCs (e.g. steer) over the same
socket. React Native injects a `webSocketFactory` that adds the Bearer header;
browsers rely on the cookie.
