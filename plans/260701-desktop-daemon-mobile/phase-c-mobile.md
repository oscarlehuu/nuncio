# Phase C — Expo Mobile Client

**Goal:** Native remote control on the frozen Phase B relay. Push notifications are the reason this is native and not just the PWA.

**Precondition:** Phase B contract frozen. Do not start otherwise.

## Stack

- **Expo (managed workflow)** — `expo-notifications` (the justification), OTA updates, dev velocity.
- **react-native-reusables + NativeWind** — the canonical shadcn *port* to RN: same component names (button/dialog/dropdown/sheet…), lucide icons, Tailwind DX. Gives the shadcn look on native.
- **Expo Router** — navigation.
- Imports `packages/core` — relay client, types, pure logic, **and design tokens** all reused.

## What transfers vs. rebuilds

- Transfers: all of `packages/core` (client + types + logic + tokens). WS client already transport-correct from B2.
- Rebuilds: every screen. RN renders native views, not DOM — radix/shadcn/cmdk/react-markdown don't run. Web components → react-native-reusables equivalents.
- **Uniform look via tokens, not shared components:** web-shadcn reads tokens as CSS vars (`index.css`); mobile-RN reads the *same* token values from `packages/core` via NativeWind config. Same palette/radius/type → identical design language, two renderers.

## Mobile-specific work

- **Pairing:** scan/enter the desktop-issued token; store securely (Expo SecureStore); persist host base URL (tailnet address).
- **Push:** register device; daemon sends push on session done / needs-input / error even when app is backgrounded. Requires a push path from daemon → Expo push service.
- **Background/resume:** on foreground, resubscribe via `since=` cursor — transcript catches up gap-free (same property as web).
- **Steer from phone:** WS RPC call, same contract as desktop.

## Acceptance

- Phone (cellular, off-tailnet-then-on) pairs with token, opens a running session, sees live token-by-token stream.
- App backgrounded → agent finishes → push arrives → tap → transcript is complete via cursor replay.
- Steer from phone lands on the same agent conversation as desktop.

## Explicitly deferred

- App store submission (start with Expo dev/internal builds).
- Offline queueing of steers (relay is the source of truth; require connectivity to steer).
