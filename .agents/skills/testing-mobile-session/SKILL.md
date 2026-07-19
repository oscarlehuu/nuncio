---
name: Testing the Nuncio mobile app on the Android emulator
description: How to run and test the Expo mobile app (apps/mobile) against the local Nuncio API on the Android emulator in Expo Go — pairing, finding a rich transcript session, and known gotchas.
---

# Testing the Nuncio mobile app (Expo Go on Android emulator)

## Services
- **API server** on `:3000` from the MAIN checkout: `cd /home/ubuntu/repos/nuncio && bun run --filter @nuncio/server start`. Health: `curl http://localhost:3000/api/health` → `{"status":"ok","service":"nuncio-server"}`. Do NOT start a second server on another port.
- **Metro/Expo** MUST run from the checkout that has the code under test. For a UI worktree: `cd <worktree>/apps/mobile && bunx expo start` (deps: `bun install`; @gorhom/bottom-sheet, react-native-svg/lucide, reanimated, gesture-handler all load in Expo Go — no native build needed). ⚠️ If Metro is already running from a different checkout (`ps aux | grep 'expo start'`), kill it first — otherwise you test the wrong UI. Metro serves on `:8081`.

## Emulator + adb
- `adb` at `/home/ubuntu/android-sdk/platform-tools/adb` (add to PATH). Emulator is `emulator-5554` (AVD `nuncio_api35`), Expo Go pkg `host.exp.exponent`.
- Open/reload the app: `adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d "exp://10.0.2.2:8081" host.exp.exponent`. From the emulator the host is `10.0.2.2`.
- **Typing gotcha:** the emulator's stylus/handwriting IME intercepts on-screen typing and pops "Try out your stylus" dialogs. Use `adb -s emulator-5554 shell input text "your%stext"` (`%s` = space) after focusing the field. Dismiss the keyboard with `adb ... input keyevent 111` (ESC).

## Pairing
- App pairs with base URL + Bearer token. Use base `http://10.0.2.2:3000`.
- Access token is at `/home/ubuntu/repos/nuncio/apps/server/data/auth-token` (also printed in server startup log: "remote clients authenticate with: <token>"). It is NOT in the settings DB table.
- Pairing persists in Expo Go SecureStore across Metro restarts, so re-pairing is usually unnecessary.

## Finding a session with a real transcript (tool cards + thinking)
Query the SQLite DB (no `sqlite3` binary; use Bun):
```
cd /home/ubuntu/repos/nuncio && bun -e "const {Database}=require('bun:sqlite');const d=new Database('apps/server/data/nuncio.db');const r=d.query('select session_id,type,count(*) c from events group by session_id,type').all();console.log(JSON.stringify(r));"
```
Pick a session with many `tool_start`/`tool_end` + `thinking_message` events. Verify a steer landed by checking for a new `steer_message` event and rising `max(seq)`.

## Devin Secrets Needed
- `NUNCIO_PI_AUTH_JSON_B64` — decoded into `~/.pi/agent/auth.json` (blueprint does this) so real Pi agent runs/steers work.
- For **EAS Build / downloading the app online from Expo**: needs the user's Expo account — interactive `eas login` or an `EXPO_TOKEN` secret. Not currently available; `eas.json`/`projectId` do not exist yet.

## Transcript render dedupe (why keys are unique)
- `useTranscriptBlocks` can emit repeated logical blocks (sharing `block.key`) when replay/`transcript_refreshed` events fold into the shared `@nuncio/core` parser output. The mobile render boundary dedupes them: `groupTranscriptBlocks` in `src/lib/session-ui.ts` keeps the latest block per key, preserves first-occurrence order, and guarantees unique `tool-group-*` render keys. If you touch that grouping, keep the dedupe or FlatList will log duplicate-key warnings (this was PR #128's regression, fixed in 12f6837 with a spec in `session-ui.spec.ts`).
