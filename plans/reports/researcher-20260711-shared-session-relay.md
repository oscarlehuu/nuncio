# Shared session relay research

## Recommendation

Build one provider-neutral `SessionRelayConnection` in `packages/core`, then let many logical
`SessionSubscription` handles lease it. Pool browser connections by the exact canonical relay URL
(including `/m/<machine>`). Keep `subscribeSessionEvents(options)` as the compatibility entrypoint.
Do not change the frozen WS v1 protocol: the server already supports multiple channels on one
socket.

Implement in two safe steps:

1. Core connection + browser pooling. This gives the Workbench win immediately: its 3-6
   `useSessionStream` instances currently each open a socket.
2. Move Expo's `ConnectionManager` ownership above the transcript hook, then attach transcript
   channels to that connection. Mobile currently shows one session at a time, so mixing this
   lifecycle refactor into the first step adds risk without an immediate socket-count win.

## Verified current state

- The server owns `Map<sessionId, unsubscribe>` per socket and already handles repeated
  subscribe, unsubscribe, steer, independent channel pushes, and channel-specific `behind`
  recovery (`apps/server/src/sessions/api/sessions.ws.ts:140-141,184-220,292-313`). No new server
  method or envelope is required.
- The frozen contract explicitly permits multiple subscribe/unsubscribe RPCs on one duplex relay
  and identifies pushes by `channel` (`docs/ws-relay-contract.md:34-51,72-96`). ADR-007 requires
  additive/versioned transport evolution, so a client-only composition change is the right seam
  (`docs/architecture-decisions.md:86-96`).
- Today each `subscribeSessionEvents()` call owns a socket, reconnect timer, RPC id counter, and
  pending map (`packages/core/src/session-relay-client.ts:85-105,172-183,248-295`).
- Workbench tiles each invoke `useSessionStream` (`apps/web/src/components/session-tile.tsx:105-119`),
  so a 3x2 grid can open six relay sockets. The hook also appears in the normal session route and
  maximized grid route (`apps/web/src/App.tsx:939-955`,
  `apps/web/src/components/grid-view.tsx:459-481`).
- Hub routing is already encoded in the URL path: `sessionRelayUrl(base)` builds
  `.../m/<machine>/api/sessions/ws` (`apps/web/src/lib/use-session-stream.ts:19-25`). Therefore the
  exact relay URL is the correct browser pool key; origin alone would incorrectly combine machines.
- Expo has a different ownership model. Its hook creates both the relay and a `ConnectionManager`;
  that manager is deliberately the sole reconnect authority and can switch candidate URLs
  (`apps/mobile/src/lib/use-session-transcript.ts:98-147`,
  `apps/mobile/src/lib/connection-manager.ts:3-14,39-59`). RN also injects auth headers at socket
  construction (`apps/mobile/src/lib/use-session-transcript.ts:116-126`).
- Current server tests cover one-channel replay/backpressure/unsubscribe well, but there is no
  explicit two-session-one-socket characterization case
  (`apps/server/test/unit/sessions/sessions.ws.spec.ts:163-510`).

## Smallest core design

Keep transport ownership separate from channel ownership:

```ts
type SessionRelayConnectionOptions = {
  url: string;
  webSocketFactory?: WebSocketFactory;
  reconnectMs?: number;
  reconnectDelays?: (attempt: number) => number;
  onNotice?: (notice: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  shouldReconnect?: () => boolean;
};

type SessionChannelOptions = {
  sessionId: string;
  since?: number;
  tail?: number;
  onEvent: (event: SessionEvent) => void;
};

interface SessionRelayConnection {
  subscribe(options: SessionChannelOptions): SessionSubscription;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  resync(): void;
  close(): void;
}
```

Suggested files, to avoid growing the existing 296-line module:

- `packages/core/src/session-relay-connection.ts`: one physical socket, global RPC ids/pending map,
  reconnect, notices, channel routing.
- `packages/core/src/session-relay-pool.ts`: browser pool/leases, keyed by canonical URL and
  connection identity.
- `packages/core/src/session-relay-client.ts`: public types plus the backward-compatible
  `subscribeSessionEvents()` facade.

### Channel state

Each physical connection keeps:

```text
channels: Map<sessionId, {
  consumers: Map<consumerId, { lastSeq, initialTail, onEvent, pendingRpcIds }>;
}>
```

- One server subscription per `sessionId`; multiple local consumers fan out from it.
- Each consumer cursor is monotonic. The physical subscribe cursor is the minimum active consumer
  cursor, preventing a newer consumer from creating a gap for a lagging one.
- On cursor zero, request the largest finite `tail`; if any consumer requests unbounded history,
  omit `tail`. Consumers with a higher cursor ignore events at or below their own cursor. After
  live delivery, their cursors converge naturally.
- A `behind` frame resubscribes only its named channel from that channel's aggregate cursor. It
  must not reconnect the socket or disturb other sessions.
- Closing one logical consumer removes only that consumer. Send server `unsubscribe` only when the
  final consumer for that session closes. Close/evict the physical connection only when its final
  lease is gone; use a zero-delay/short idle disposal to avoid React StrictMode teardown/recreate
  socket churn.

### Reconnect and RPC semantics

- A physical close rejects every in-flight RPC and schedules exactly one reconnect. On open,
  resubscribe every active session with its own aggregate cursor.
- Never retry `call()` automatically. `steer` or future external-write RPCs may have reached the
  daemon before a connection drop; replaying them could duplicate a side effect.
- `SessionSubscription.call()` remains for compatibility, but associate pending ids with its
  logical handle. Closing one handle rejects only its calls, not calls owned by other handles.
- `subscription.resync()` resubscribes that session when the socket is live. If dead, it triggers
  one connection reopen, which restores all channels.
- `subscription.confirmResync()` correlates only that session's subscribe ACK and leaves other
  RPCs untouched, preserving the current mobile half-open check.
- Ignore frames from stale physical socket generations, as current code already does via
  `socket !== ws` (`packages/core/src/session-relay-client.ts:178-187,229-231`).

### Backward-compatible API

`subscribeSessionEvents(options)` retains its current signature and return type. For plain browser
callers (no injected factory/lifecycle controller), it leases the default pooled connection for
`options.url`. This makes current web hooks share automatically without a component API change.

Do not silently pool arbitrary injected factories/callback policies by URL. Two callers can use
the same URL with different Bearer credentials or reconnect authority. Either:

- accept an additive `connection?: SessionRelayConnection` option; or
- export `createSessionRelayConnection()` and have the owner call `connection.subscribe()`.

Use the explicit connection path for Expo. Keep the old one-off behavior for injected/lifecycle
options until its owner is lifted. This preserves existing tests and avoids double reconnection.

## Tests to write first

### Core red tests

Create `packages/core/src/session-relay-connection.spec.ts` before implementation:

1. **one socket, two sessions**: two subscriptions to the same connection create one `FakeSocket`,
   then send two subscribe frames on open.
2. **channel routing + independent cursors**: `s1@4` and `s2@20` events reach only their callbacks;
   reconnect sends `since:4` and `since:20` respectively.
3. **channel-local behind**: `{channel:'s1',behind:true}` resubscribes only `s1`; `s2` continues and
   keeps its cursor.
4. **independent unsubscribe**: close `s1`, assert one unsubscribe and an open socket; `s2` still
   receives events. Closing the final lease disposes once.
5. **duplicate local consumers**: two consumers of `s1` cause one physical subscribe and fan-out;
   closing one does not unsubscribe. Cover min-cursor/max-tail aggregation.
6. **single reconnect authority**: one socket drop invokes connection `onClose` once, creates one
   timer/socket, rejects pending RPCs, and restores every active channel on open.
7. **RPC isolation**: concurrent RPCs from two handles correlate globally; closing handle A rejects
   A's pending call only; no call is retried after reconnect.
8. **resync semantics**: live per-handle resync sends only that channel; dead resync creates one
   socket and restores all; confirm timeout does not disturb another RPC.
9. **notice semantics**: `server_shutdown` reaches the connection owner once, not once per channel.
10. **stale generation/invalid frames**: old socket messages, wrong channel, and invalid JSON do not
    mutate cursors or callbacks.

Then add browser pool tests in `packages/core/src/session-relay-pool.spec.ts`:

1. Same exact relay URL shares one connection.
2. `/m/mac-a/...` and `/m/mac-b/...` do not share even on the same hub origin.
3. Different explicit connection identities/factories do not share.
4. Final lease eviction closes once; a StrictMode-like immediate reacquire does not create a storm.
5. Test cleanup can deterministically close/reset the pool to prevent cross-spec leakage.

### Web integration red tests

Extend `apps/web/src/lib/use-session-stream.spec.tsx`:

1. Render two hook harnesses with different session ids and the same base; assert one WebSocket and
   two subscribe frames.
2. Push interleaved channel events; each hook receives only its session.
3. Unmount one hook; assert the other remains live and the socket stays open.
4. Render two hub bases; assert two sockets and no cross-machine delivery.
5. Drop the shared socket after both cursors advance; assert one reconnect and two correct cursors.

Existing specs index `MockWebSocket.instances` and assume a hook owns its socket
(`apps/web/src/lib/use-session-stream.spec.tsx:305-530`); update those assertions deliberately,
not by loosening them.

### Server characterization

Add one focused case to `apps/server/test/unit/sessions/sessions.ws.spec.ts`:

- subscribe `s1` and `s2` on one real socket, verify interleaved channel routing, unsubscribe `s1`,
  verify `s2` remains live.

This may pass before the client implementation because the server capability already exists. It is
contract evidence, not the TDD red test for the client change.

### Expo tests before its migration

Keep all current `connection-manager.spec.ts` and `connection-integration.spec.ts` cases green,
especially sole reconnect authority, `server_shutdown`, candidate URL switching, stale probe
generation, and foreground `confirmResync` (`apps/mobile/src/lib/connection-manager.spec.ts:90-359`,
`apps/mobile/src/lib/connection-integration.spec.ts:135-280`). Add:

1. Two transcript channels share a connection but produce one `handleOpen`/`handleClose` callback.
2. Candidate URL switch replaces one physical connection and restores both cursors.
3. Secret rotation on the same URL forces/requires a new socket factory invocation with the current
   header; never reuse a live socket under a revoked credential.
4. `server_shutdown` freezes the one transport, then cooldown recovery restores all channels once.

## Migration risks and mitigations

| Risk | Mitigation |
|---|---|
| Server supports only one listener per session per socket | Fan out duplicate same-session consumers locally; never issue parallel physical subscribes for the same `sessionId`. |
| One hot stream contributes to the shared 1 MB socket buffer and may cause another channel to receive `behind` | Preserve channel-specific recovery; instrument `behind` by channel. Do not change the frozen bound in this work. |
| Web test/HMR/global pool leakage | Deterministic pool disposal/reset; HMR cleanup; exact URL keys; no origin-only singleton. |
| React StrictMode closes the final lease then immediately reacquires it | Defer idle disposal briefly and cancel it on reacquire. |
| Hub cross-machine data leak | Key by full canonical URL including `/m/<machine>`; add explicit two-machine test. |
| Mobile double reconnect | One connection-level lifecycle owner only. Do not fan `onClose` to every channel or combine the Expo lift with browser pooling. |
| Mobile auth/candidate URL drift | Treat selected URL + credential generation as transport identity; recreate socket on URL/credential change. Factory reads current auth at connect time. |
| Shared socket close rejects more RPCs at once | Expected, but reject each promise exactly once and never auto-retry side-effecting RPCs. UI may fall back to REST/user retry. |
| Duplicate/out-of-order replay across local consumers | Per-consumer monotonic cursors plus existing seq-based UI merge; physical reconnect uses minimum active cursor. |
| Pool keeps idle sockets forever | Refcount plus bounded idle eviction; expose metrics for physical sockets, logical channels, reconnects, and behind recovery. |
| Current subscribe errors are mostly unobserved | Do not broaden scope silently. Preserve behavior first; a future additive subscription-state/error callback can surface 404/400. |

## Acceptance signals

- Six same-machine Workbench tiles: one physical relay socket, six logical channels.
- Cross-machine grid: one socket per distinct `/m/<machine>` base.
- Reconnect creates one socket and resumes every channel from its own durable cursor.
- Channel-local `behind` and unsubscribe do not interrupt neighboring sessions.
- Existing `subscribeSessionEvents` call sites compile unchanged.
- All core/web/mobile relay suites stay green; real browser smoke confirms grid streaming and steer.
- Runtime metrics distinguish physical sockets from logical subscriptions so the win is measurable.

## Unresolved questions

None for browser/core implementation. Expo transport ownership should be a separate follow-up phase,
not a blocker for the Workbench improvement.

**Status:** DONE
**Summary:** Verified server v1 already supports multiplexed session channels; proposed a client-side shared connection/pool with backward-compatible web migration and staged Expo ownership lift.
**Concerns/Blockers:** Mobile reconnect/auth ownership must remain connection-level; pooling injected factories by URL alone is unsafe.
