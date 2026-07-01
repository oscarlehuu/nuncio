# Nuncio Desktop → Daemon → Mobile Roadmap

**Status:** Planning · supersedes nothing (extends Phases 0–3 shipped)
**Thesis:** The host that runs agents is a desktop. Mobile is a native remote control. Build the host + relay first (Pi SDK lane), then point clients at it. Synara-shaped: local-first daemon + unified GUI + token-gated remote access.

**Reference validation:** Synara (fork of T3Code) — the app we're modeling — independently uses our exact stack: shadcn/ui + Radix + Tailwind + React/Vite + Electron + Bun + Turborepo (`apps/desktop` + `apps/web` + `packages/`). We match its proven structure for desktop, and go one step beyond it on mobile (Synara has no native app — its "mobile" is responsive web over the daemon; we ship a real Expo app for push).

## Decisions (locked)

| Decision | Choice | Why |
|----------|--------|-----|
| Desktop shell | **Electron** | Renders Chromium/DOM → reuses existing shadcn `apps/web` verbatim, no UI rewrite. Runs the Bun/Nest daemon as a child process. Best tray/notifications/auto-update. Exactly what Synara uses. |
| Desktop UI | **Existing shadcn/ui, re-tuned desktop-first** | shadcn is Radix-based (real keyboard nav, focus, ARIA) and copy-owned (tune every pixel native-dense). Same library Synara ships at scale. No new UI library for desktop. |
| Mobile UI | **react-native-reusables + NativeWind** | The canonical shadcn *port* to RN — same component names, lucide icons, Tailwind DX. Delivers the shadcn look on native by sharing design tokens (not component code). |
| Shared logic + tokens | **Extract `packages/core`** | One typed relay contract + one design-token source (palette/radius/typography) consumed by web-shadcn (CSS vars) and mobile-RN (NativeWind config). Mobile is a thin client, not a second codebase. |
| Transport | **WebSocket RPC + event-log cursor** | Matches Synara (`wsRpc`, backpressure). Bidirectional/multiplexed for steer + future terminals/dev-server logs. Keep our persisted `seq` cursor on top for gap-free resume that raw WS doesn't give. |
| Mobile stack | **Expo (React Native) + NativeWind + Expo Router** | Push notifications ("agent finished") are the justification for going native beyond Synara's PWA model; Expo delivers that + OTA. |
| Render feel | **Throttled reveal + backpressure** | "Better than CLI" = token-granular events + adaptive client reveal + server backpressure. Not a transport property. |
| ~~PWA~~ | **Dropped** | The PWA existed only to reach a phone without a native app; desktop (host) + Expo (remote) now cover both surfaces. Removing it frees `apps/web` from mobile-first compromise → desktop-first. No phone access between desktop ship and Expo ship — accepted, since order is desktop→mobile. Stop investing now; delete scaffolding when Expo lands. |

## Why this order (dependency, not preference)

The daemon runs agents **in-process on the host**: filesystem, git, spawning `cursor` CLI, Pi SDK. That host is a desktop/laptop. Mobile is useless without a running host, so the host + relay must be solid first. Today the host is a hand-started `bun dev` + Tailscale — the biggest friction in the product. Desktop-first collapses the host into one installable, always-on thing.

## Phases

| Phase | Focus | Plan |
|-------|-------|------|
| A | Electron shell wrapping `apps/web` + supervising the Bun daemon | [phase-a-desktop-shell.md](./phase-a-desktop-shell.md) |
| B | `packages/core` extraction + WS relay + token auth + backpressure + multiplex stream | [phase-b-daemon-relay.md](./phase-b-daemon-relay.md) |
| C | Expo mobile client on the same relay contract | [phase-c-mobile.md](./phase-c-mobile.md) |

Ordering rule: **A ships a usable desktop on today's SSE. B hardens the relay to WS + core. C consumes the frozen contract.** Do not start C until B's contract is stable.

## What already exists (do not rebuild)

- Durable event log with monotonic `seq` (`events.repository.ts`) — the resume foundation.
- Cursor endpoints: `GET :id/events?since=` (replay) + `GET :id/stream?since=` (live SSE) — `sessions.controller.ts`.
- Reconnect-safe client with dedupe/sort (`use-session-stream.ts`).
- Throttled reveal (`use-throttled-stream-text.ts`) — reused; needs adaptive-pace tuning (currently fixed 40 cps typewriter).
- Provider-neutral agent layer (`AgentRegistry`): Pi, Cursor agent, Cursor CLI, Mock.

## Target repo shape

```
packages/core     ← relay client + types + pure lib + design tokens (no DOM, explicit host base URL)
apps/server       ← Bun/Nest daemon (WS relay, token auth, backpressure)
apps/web          ← shadcn client (Chromium/DOM), imports core; re-tuned desktop-first, PWA dropped
apps/desktop      ← Electron shell, supervises daemon, wraps apps/web
apps/mobile       ← Expo + react-native-reusables + NativeWind, imports core (Phase C)
```

Mirrors Synara's Turborepo layout (`apps/desktop` + `apps/web` + `packages/`), extended with `apps/mobile`.

## Open tuning items (flagged, not blocking)

- Adaptive reveal pace in `use-throttled-stream-text` (track arrival, not fixed cps).
- Backpressure strategy on the WS relay (Synara's `wsStreamBackpressure` lesson) — bound per-connection buffer, drop-to-cursor on overflow (client re-fetches via `since=`).
- Token model: bearer on WS connect + REST; localhost bypass; token generated by desktop app, surfaced for phone pairing.
