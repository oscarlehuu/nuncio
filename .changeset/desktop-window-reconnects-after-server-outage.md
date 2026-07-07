---
"nuncio": patch
---

The desktop window no longer goes permanently blank when its local server restarts underneath it. Reloading while the Vite dev server (or the packaged daemon) is briefly down used to land on Chromium's error page, which never recovers on its own while the window is in the background — the window stayed blank until someone reloaded it by hand. The shell now parks on a "Waiting for the Nuncio server…" page and reloads the app automatically as soon as the server answers again.
