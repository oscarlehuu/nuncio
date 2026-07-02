---
"nuncio": minor
---

Native mobile app (`apps/mobile`, Expo + Expo Router + NativeWind): pair the phone with your machine by Tailscale address + access token (kept in the iOS/Android secure store; hub base paths like `/m/<machine>` pair too), browse active/archived sessions, create a session with the provider/model catalog, watch the live transcript over the session WS relay (markdown, tool and thinking rows, gap-free resume when the app returns to the foreground), steer over the same socket, and pause/archive/restore/delete with a delete confirm. The palette derives from the shared `@nuncio/core` design tokens.
