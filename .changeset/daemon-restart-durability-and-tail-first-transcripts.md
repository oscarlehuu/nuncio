---
"nuncio": minor
---

Made the daemon restart-safe and long transcripts cheap. Sessions left RUNNING by a dead daemon are reconciled on boot — the active turn is cleared, a `runtime_restarted` marker (with whether the thread is resumable) lands in the transcript, and the session settles on IDLE so you can steer it again; Pi sessions resume the same conversation through their on-disk session file. The event log now serves bounded windows (`tail`, `before`, `limit`): the session view opens with the last 1000 events and pages older history in via a "Load earlier history" button, grid tiles subscribe to a 300-event tail, live events fan out without re-reading the whole log, and a 128 KB payload ceiling stops any single tool output from bloating a session forever.
