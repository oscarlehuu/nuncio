---
"nuncio": minor
---

Push notifications for the mobile app: devices register their Expo push token (`POST /api/push/register`, auth-gated, stored in SQLite) and the server sends a push through Expo's service whenever a session finishes, errors, or asks for input — even with the app backgrounded. Tapping the notification opens that session's transcript, caught up gap-free via the event-log cursor. Requires a dev/production Expo build with an EAS project id (Expo Go cannot receive remote pushes); without one the app silently skips registration.
